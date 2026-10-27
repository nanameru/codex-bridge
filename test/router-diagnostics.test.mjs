import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRouterDiagnostics, transportErrorCodes, observeRouterProcess } from '../src/router-diagnostics.mjs';
import { createRouter } from '../src/model-router.mjs';

const catalog = { models: [{ slug: 'gpt-test', router_provider: 'openai' }] };

test('diagnostics omit bodies, secrets, URLs, messages and unknown error codes', () => {
  const events = [];
  const diagnostics = createRouterDiagnostics({ write: event => events.push(event), now: () => 0, pid: 42 });
  const request_id = randomUUID();
  const secret = 'private-thread-or-token';
  diagnostics.record('router_request_started', { request_id, thread_ref: secret,
    body: secret, authorization: secret, message: secret, path: 'https://secret.example/' });
  assert.equal(events[0].timestamp, '1970-01-01T00:00:00.000Z');
  assert.equal(events[0].process_id, 42);
  assert.equal(events[0].request_id, request_id);
  assert.ok(!JSON.stringify(events).includes(secret));
  assert.ok(!JSON.stringify(events).includes('secret.example'));
  const ref = diagnostics.threadRef(secret);
  assert.match(ref, /^[a-f0-9]{24}$/);
  assert.equal(ref, diagnostics.threadRef(secret));
  assert.notEqual(ref, createRouterDiagnostics().threadRef(secret));
  diagnostics.record('router_request_finished', { thread_ref: ref, transport_error_codes: ['ECONNRESET', secret] });
  assert.deepEqual(events[1].transport_error_codes, ['ECONNRESET']);
  diagnostics.record(secret);
  assert.equal(events.length, 2);
  assert.doesNotThrow(() => createRouterDiagnostics({ write() { throw Error('disk full'); } }).record('router_started'));
});

test('nested aggregate transport errors are sanitized and cycles are bounded', () => {
  const error = new AggregateError([{ code: 'ECONNREFUSED', message: 'secret' }, { code: 'ENETUNREACH' }]);
  error.cause = { code: 'UND_ERR_CONNECT_TIMEOUT', cause: error };
  assert.deepEqual(transportErrorCodes(error), ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENETUNREACH']);
});

test('process monitor observes exits without adding an exception handler', () => {
  const runtime = new EventEmitter();
  const events = [];
  const remove = observeRouterProcess(runtime, createRouterDiagnostics({ write: e => events.push(e) }), () => 2);
  assert.equal(runtime.listenerCount('uncaughtException'), 0);
  runtime.emit('uncaughtExceptionMonitor', { code: 'ENOSPC', message: 'private' }, 'uncaughtException');
  runtime.emit('exit', 1);
  assert.equal(events[0].active_requests, 2);
  assert.deepEqual(events[0].transport_error_codes, ['ENOSPC']);
  assert.equal(events[1].exit_code, 1);
  assert.ok(!JSON.stringify(events).includes('private'));
  remove();
  assert.equal(runtime.listenerCount('exit'), 0);
});

async function fixture(t, fetcher, options = {}) {
  const events = [];
  const router = createRouter({ catalog, fetcher, authenticate: () => true,
    diagnostics: createRouterDiagnostics({ write: event => events.push(event) }), ...options });
  router.listen(0, '127.0.0.1');
  await once(router, 'listening');
  t.after(() => new Promise(resolve => { router.closeAllConnections(); router.close(resolve); }));
  const send = () => fetch(`http://127.0.0.1:${router.address().port}/v1/responses`, {
    method: 'POST', headers: { authorization: 'Bearer private-token', session_id: 'private-thread' },
    body: JSON.stringify({ model: 'gpt-test', input: [{ type: 'compaction_trigger' }] }),
  });
  return { send, events, router };
}

test('pending compaction remains traceable before headers; completion shares request identity', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let reached;
  const arrived = new Promise(resolve => { reached = resolve; });
  const { send, events, router } = await fixture(t, async () => {
    reached(); await pending;
    return new Response('ok');
  });
  const response = send();
  await arrived;
  assert.deepEqual(events.map(e => e.event), ['router_request_started', 'router_request_decoded', 'router_request_upstream']);
  assert.equal(router.activeRequestCount(), 1);
  assert.equal(events[1].request_kind, 'remote_compaction');
  release();
  assert.equal(await (await response).text(), 'ok');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.slice(-2).map(e => e.event), ['router_request_headers', 'router_request_finished']);
  assert.equal(events.at(-1).stage, 'complete');
  assert.equal(new Set(events.map(e => e.request_id)).size, 1);
  assert.equal(router.activeRequestCount(), 0);
  assert.ok(!JSON.stringify(events).includes('private'));
});

test('header transport failure records sanitized code and failed stage', async t => {
  const { send, events } = await fixture(t, async () => {
    throw new TypeError('private URL/token', { cause: { code: 'ECONNRESET' } });
  });
  const response = await send();
  assert.equal(response.status, 502);
  await response.text();
  const finish = events.at(-1);
  assert.equal(finish.event, 'router_request_finished');
  assert.equal(finish.stage, 'upstream_headers');
  assert.deepEqual(finish.transport_error_codes, ['ECONNRESET']);
  assert.equal(finish.termination_reason, 'upstream_error');
  assert.ok(!JSON.stringify(events).includes('private'));
});

test('deadline while awaiting upstream headers is distinct from transport failure', async t => {
  const { send, events } = await fixture(t, async (_url, { signal }) => {
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { timeoutMs: 40 });
  const response = await send();
  assert.equal(response.status, 504);
  await response.text();
  assert.equal(events.at(-1).termination_reason, 'deadline_exceeded');
});

test('stream reset after headers retains the stream stage and request identity', async t => {
  const { send, events } = await fixture(t, async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {}\n\n'));
      setTimeout(() => controller.error(Object.assign(Error('private-upstream-message'), { code: 'ECONNRESET' })), 20);
    },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const response = await send();
  await response.text();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.at(-1).stage, 'upstream_stream');
  assert.equal(events.at(-1).termination_reason, 'upstream_stream_error');
  assert.deepEqual(events.at(-1).transport_error_codes, ['ECONNRESET']);
  assert.equal(new Set(events.map(e => e.request_id)).size, 1);
  assert.ok(!JSON.stringify(events).includes('private'));
});


test('real uncaught exception retains the default nonzero process exit', () => {
  const moduleUrl = new URL('../src/router-diagnostics.mjs', import.meta.url).href;
  const script = `import { createRouterDiagnostics, observeRouterProcess } from ${JSON.stringify(moduleUrl)};
    observeRouterProcess(process, createRouterDiagnostics({ write: e => process.stdout.write(JSON.stringify(e) + "\\n") }));
    throw Object.assign(new Error('fixture failure'), { code: 'ENOSPC' });`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /router_fatal/);
  assert.match(result.stdout, /router_exit/);
  assert.match(result.stdout, /ENOSPC/);
});
