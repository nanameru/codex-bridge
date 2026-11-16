// Opt-in, isolated, serial Issue #198 memory measurement. It is not a test runner.
// node test/fixtures/router-input-memory-probe.mjs
// Both cases include the synthetic producer, router, and loopback sink in one child.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { fixture, imageRequest, send } from './router-input-fixture.mjs';

const MiB = 1024 * 1024;
const cases = { '34MiB': 34 * MiB, 'near128MiB': 127 * MiB };

async function measure(name) {
  const started = performance.now();
  let f;
  try {
    // Never read input limits inherited from a real service.
    delete process.env.ROUTER_MAX_FORWARDED_BYTES;
    delete process.env.ROUTER_MAX_REQUEST_BYTES;
    f = await fixture();
    const wire = JSON.stringify(imageRequest(cases[name]));
    const inputBytes = Buffer.byteLength(wire);
    const response = await send(f.base, wire);
    const status = response.status; await response.arrayBuffer();
    const usage = process.resourceUsage();
    return { case: name, input_bytes: inputBytes, forwarded_bytes: f.calls[0]?.bytes ?? 0,
      upstream_calls: f.calls.length, http_status: status, result: status === 200 && f.calls.length === 1 ? 'pass' : 'fail',
      wall_ms: Math.round(performance.now() - started), max_rss_kib: usage.maxRSS,
      user_cpu_us: usage.userCPUTime, system_cpu_us: usage.systemCPUTime };
  } catch {
    return { case: name, result: 'error', wall_ms: Math.round(performance.now() - started),
      max_rss_kib: process.resourceUsage().maxRSS };
  } finally { if (f) await f.close(); }
}

if (process.argv[2] === '--case' && Object.hasOwn(cases, process.argv[3])) {
  const result = await measure(process.argv[3]);
  console.log(JSON.stringify(result));
  if (result.result !== 'pass') process.exitCode = 1;
} else if (process.argv.length === 2) {
  for (const name of Object.keys(cases)) {
    const env = { ...process.env };
    delete env.ROUTER_MAX_FORWARDED_BYTES; delete env.ROUTER_MAX_REQUEST_BYTES;
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--case', name],
      { env, encoding: 'utf8', timeout: 240000, maxBuffer: 8192 });
    let result;
    try { result = JSON.parse(child.stdout); }
    catch { result = { case: name, result: child.error?.code === 'ETIMEDOUT' ? 'timeout' : 'child_failed' }; }
    result.child_exit = child.status;
    result.child_signal = child.signal;
    result.platform = process.platform;
    result.arch = process.arch;
    result.node = process.version;
    console.log(JSON.stringify(result));
    if (child.status !== 0 || result.result !== 'pass') process.exitCode = 1;
  }
} else {
  console.error('usage: node test/fixtures/router-input-memory-probe.mjs [--case 34MiB|near128MiB]');
  process.exitCode = 2;
}
