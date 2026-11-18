import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import * as zlib from 'node:zlib';
import { createRouter, catalog, fixture, imageRequest, send } from './fixtures/router-input-fixture.mjs';

const MiB = 1024 * 1024;
const LIMITS = ['ROUTER_MAX_FORWARDED_BYTES', 'ROUTER_MAX_REQUEST_BYTES'];
const codecs = [['identity', value => value], ['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync],
  ['br', zlib.brotliCompressSync], ['zstd', zlib.zstdCompressSync]].filter(([, fn]) => typeof fn === 'function');

function withLimits(values, fn) {
  const previous = Object.fromEntries(LIMITS.map(key => [key, process.env[key]]));
  for (const key of LIMITS) {
    if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key];
  }
  try { return fn(); } finally {
    for (const key of LIMITS) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
}

async function withLimitsAsync(values, fn) {
  const previous = Object.fromEntries(LIMITS.map(key => [key, process.env[key]]));
  for (const key of LIMITS) {
    if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key];
  }
  try { return await fn(); } finally {
    for (const key of LIMITS) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
}

// This named test also runs against the fixed base fixture through ROUTER_TEST_MODULE.
test('AC-01 synthetic 34 MiB image history crosses the default forwarding boundary', async t => {
  const f = await withLimitsAsync({}, () => fixture()); t.after(() => f.close());
  const wire = JSON.stringify(imageRequest(34 * MiB));
  assert.ok(Buffer.byteLength(wire) > 32 * MiB && Buffer.byteLength(wire) < 128 * MiB);
  const response = await send(f.base, wire);
  const status = response.status; await response.text();
  assert.equal(status, 200, `default router should accept synthetic history; upstream_calls=${f.calls.length}`);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].bytes > 32 * MiB && f.calls[0].bytes < 128 * MiB);
});

test('AC-02 defaults and independent input environment are reported by health', async t => {
  for (const [values, forwarded, received] of [
    [{}, 128 * MiB, 128 * MiB],
    [{ ROUTER_MAX_FORWARDED_BYTES: '1' }, 1, 128 * MiB],
    [{ ROUTER_MAX_FORWARDED_BYTES: '1', ROUTER_MAX_REQUEST_BYTES: '1' }, 1, 1],
    [{ ROUTER_MAX_REQUEST_BYTES: String(256 * MiB) }, 128 * MiB, 256 * MiB],
    [{ ROUTER_MAX_FORWARDED_BYTES: '1234', ROUTER_MAX_REQUEST_BYTES: '4567' }, 1234, 4567],
    [{ ROUTER_MAX_FORWARDED_BYTES: String(512 * MiB), ROUTER_MAX_REQUEST_BYTES: String(512 * MiB) }, 512 * MiB, 512 * MiB],
  ]) {
    const f = await withLimitsAsync(values, () => fixture());
    try {
      const health = await (await fetch(f.base + '/health')).json();
      assert.deepEqual(health.request_limits, { received_bytes: received, decoded_bytes: received, forwarded_bytes: forwarded });
    } finally { await f.close(); }
  }
});

test('AC-02 invalid decimal syntax, range, and inverted limits fail closed', () => {
  const invalid = ['', '0', '-1', '+1', '1.0', '1e3', ' 1', '1 ', '1\n', '１', 'Infinity', 'NaN', '0x10', String(512 * MiB + 1), '9007199254740992'];
  for (const name of LIMITS) for (const value of invalid) {
    withLimits({ [name]: value }, () => assert.throws(() => createRouter({ catalog }), undefined, `${name}=${JSON.stringify(value)}`));
  }
  withLimits({ ROUTER_MAX_FORWARDED_BYTES: '2', ROUTER_MAX_REQUEST_BYTES: '1' },
    () => assert.throws(() => createRouter({ catalog })));
  for (const options of [
    { maxForwardedBytes: 0 }, { maxForwardedBytes: 512 * MiB + 1 }, { maxForwardedBytes: 1.5 },
    { maxRequestBytes: 0 }, { maxRequestBytes: Infinity }, { maxRequestBytes: 512 * MiB + 1 },
    { maxForwardedBytes: 2, maxRequestBytes: 1 },
  ]) withLimits({}, () => assert.throws(() => createRouter({ catalog, ...options })));
});

test('AC-02 invalid input environment stops CLI before listening', t => {
  const root = mkdtempSync(join(tmpdir(), 'router-cli-198-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'unified-model-catalog.json'), JSON.stringify(catalog));
  const entry = process.env.ROUTER_TEST_MODULE || resolve('src/model-router.mjs');
  for (const values of [
    { ROUTER_MAX_FORWARDED_BYTES: '0' }, { ROUTER_MAX_FORWARDED_BYTES: '1e3' },
    { ROUTER_MAX_FORWARDED_BYTES: '1\n' },
    { ROUTER_MAX_REQUEST_BYTES: 'NaN' }, { ROUTER_MAX_REQUEST_BYTES: String(512 * MiB + 1) },
    { ROUTER_MAX_FORWARDED_BYTES: '2', ROUTER_MAX_REQUEST_BYTES: '1' },
  ]) {
    const env = { ...process.env, CODEX_HOME: root, ROUTER_PORT: '0', CODEX_CLI_MODEL_SYNC: '0', ...values };
    for (const key of LIMITS) if (!(key in values)) delete env[key];
    const child = spawnSync(process.execPath, [entry], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(child.error, undefined, 'invalid configuration should exit instead of hanging');
    assert.notEqual(child.status, 0);
    assert.doesNotMatch(child.stdout, /listening/i);
    assert.match(child.stderr, /ROUTER_MAX_|受信上限/);
  }
});

function utf8Body(bytes) {
  const prefix = JSON.stringify({ model: 'gpt-test', input: '界' });
  const padding = bytes - Buffer.byteLength(prefix);
  assert.ok(padding >= 0);
  return Buffer.from(JSON.stringify({ model: 'gpt-test', input: '界' + 'x'.repeat(padding) }));
}

test('AC-04 only one large input is processed while small requests keep working', { timeout: 15000 }, async t => {
  const small = utf8Body(1024);
  const large = utf8Body(32 * MiB + 1);
  const compressed = zlib.gzipSync(large);
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let upstreamCalls = 0;
  const f = await fixture({ fetcher: async () => {
    if (++upstreamCalls === 1) {
      started.resolve();
      await finish.promise;
    }
    return Response.json({ id: 'synthetic', output: [] });
  } });
  t.after(async () => { finish.resolve(); await f.close(); });
  const headers = { 'content-encoding': 'gzip' };
  const active = send(f.base, compressed, headers);
  // Register a rejection handler while assertions inspect the competing requests.
  active.catch(() => {});
  await started.promise;

  const encoded = await send(f.base, compressed, headers);
  assert.equal(encoded.status, 503);
  assert.equal(encoded.headers.get('retry-after'), '1');
  assert.equal((await encoded.json()).error.type, 'large_input_busy');

  // Write a chunked body without an end marker. The router must reply while
  // reading the body, without waiting for the client to finish uploading.
  const chunked = await new Promise((resolve, reject) => {
    const request = http.request(f.base + '/v1/responses', {
      method: 'POST', headers: { authorization: 'Bearer synthetic', 'transfer-encoding': 'chunked' },
      signal: AbortSignal.timeout(5000),
    }, response => {
      response.setEncoding('utf8');
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.write(large);
  });
  assert.equal(chunked.status, 503);
  assert.equal(JSON.parse(chunked.body).error.type, 'large_input_busy');
  assert.equal(upstreamCalls, 1);
  const smallResponse = await send(f.base, zlib.gzipSync(small), headers);
  assert.equal(smallResponse.status, 200);
  await smallResponse.text();

  finish.resolve();
  const firstResponse = await active;
  assert.equal(firstResponse.status, 200);
  await firstResponse.text();
  const retry = await send(f.base, compressed, headers);
  assert.equal(retry.status, 200);
  await retry.text();
  assert.equal(upstreamCalls, 3);
});

test('AC-04 rejected and disconnected requests release the large input slot', { timeout: 15000 }, async t => {
  const bad = zlib.gzipSync(Buffer.alloc(32 * MiB + 1, 0x20));
  const body = zlib.gzipSync(utf8Body(32 * MiB + 1));
  const headers = { 'content-encoding': 'gzip' };
  const started = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  let upstreamCalls = 0;
  const f = await fixture({
    fetcher: async (_url, { signal }) => {
      if (++upstreamCalls === 1) {
        started.resolve();
        await new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return Response.json({ id: 'synthetic', output: [] });
    },
    onMetric: metric => { if (metric.outcome === 'aborted') cancelled.resolve(); },
  });
  t.after(() => f.close());
  const rejected = await send(f.base, bad, headers);
  assert.equal(rejected.status, 400);
  await rejected.text();
  assert.equal(upstreamCalls, 0);

  const controller = new AbortController();
  const active = fetch(f.base + '/v1/responses', {
    method: 'POST', headers: { ...headers, authorization: 'Bearer synthetic' },
    body, signal: controller.signal,
  });
  const aborted = assert.rejects(active, { name: 'AbortError' });
  await started.promise;
  controller.abort();
  await aborted;
  await cancelled.promise;
  const retry = await send(f.base, body, headers);
  assert.equal(retry.status, 200);
  await retry.text();
  assert.equal(upstreamCalls, 2);
});

test('AC-03 UTF-8 received and decoded byte limits are inclusive for each available encoding', async t => {
  const limit = 1024;
  const f = await fixture({ maxForwardedBytes: limit, maxRequestBytes: limit }); t.after(() => f.close());
  for (const [name, compress] of codecs) {
    for (const delta of [-1, 0, 1]) {
      const plain = utf8Body(limit + delta), wire = compress(plain);
      assert.equal(plain.length, limit + delta);
      const before = f.calls.length;
      const response = await send(f.base, wire, { 'content-encoding': name });
      assert.equal(response.status, delta > 0 ? 413 : 200, `${name} decoded ${delta}`); await response.text();
      assert.equal(f.calls.length, before + (delta > 0 ? 0 : 1), name);
    }
  }
});

test('AC-03 UTF-8 forwarded bytes are inclusive independently of the receive limit', async t => {
  const maxForwardedBytes = 1024;
  const f = await fixture({ maxForwardedBytes, maxRequestBytes: 4096 }); t.after(() => f.close());
  // Native route keeps this body exactly; count UTF-8, not JavaScript characters.
  for (const delta of [-1, 0, 1]) {
    const wire = utf8Body(maxForwardedBytes + delta);
    assert.equal(wire.length, maxForwardedBytes + delta);
    const before = f.calls.length;
    const response = await send(f.base, wire);
    assert.equal(response.status, delta > 0 ? 413 : 200); await response.text();
    assert.equal(f.calls.length, before + (delta > 0 ? 0 : 1));
  }
  for (const delta of [-1, 0, 1]) {
    const stub = JSON.stringify({ model: 'test', input: '界' });
    const input = '界' + 'x'.repeat(maxForwardedBytes + delta - Buffer.byteLength(stub));
    const original = JSON.stringify({ model: 'opencode/test', input });
    assert.equal(Buffer.byteLength(JSON.stringify({ model: 'test', input })), maxForwardedBytes + delta);
    const before = f.calls.length;
    const response = await send(f.base, original);
    assert.equal(response.status, delta > 0 ? 413 : 200); await response.text();
    assert.equal(f.calls.length, before + (delta > 0 ? 0 : 1));
  }
});

test('AC-03 wire bytes reject before decompression, over-expansion and unauthenticated requests never reach upstream', async t => {
  const limit = 1024;
  const f = await fixture({ maxForwardedBytes: limit, maxRequestBytes: limit }); t.after(() => f.close());
  const exact = utf8Body(limit);
  // Valid identity JSON plus whitespace is still valid JSON and isolates wire bytes.
  for (const size of [limit - 1, limit, limit + 1]) {
    const body = Buffer.concat([utf8Body(limit - 1), Buffer.alloc(size - (limit - 1), 0x20)]);
    const before = f.calls.length;
    const r = await send(f.base, body); assert.equal(r.status, size > limit ? 413 : 200); await r.text();
    assert.equal(f.calls.length, before + (size > limit ? 0 : 1));
  }
  for (const [name, compress] of codecs.filter(([name]) => name !== 'identity')) {
    const body = compress(Buffer.concat([exact, Buffer.from(' ')]));
    assert.ok(body.length < limit, `${name} must isolate decoded overflow`);
    const before = f.calls.length;
    const r = await send(f.base, body, { 'content-encoding': name });
    assert.equal(r.status, 413, name); await r.text(); assert.equal(f.calls.length, before);
  }
  const before = f.calls.length;
  const denied = await send(f.base, exact, { authorization: 'Bearer wrong' });
  assert.equal(denied.status, 401); await denied.text();
  assert.equal(f.calls.length, before);
});
