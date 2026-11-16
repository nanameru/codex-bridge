// Shared, synthetic loopback fixture for Issue #198; never reads a real key.
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.ROUTER_TEST_MODULE
  ? pathToFileURL(resolve(process.env.ROUTER_TEST_MODULE)).href
  : new URL('../../src/model-router.mjs', import.meta.url).href;
export const { createRouter, routedBody } = await import(modulePath);
export const catalog = { models: [
  { slug: 'gpt-test', router_provider: 'openai' },
  { slug: 'opencode/test', router_provider: 'opencode', router_model: 'test' },
] };

export async function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'router-input-198-'));
  const calls = [], metrics = [];
  const upstream = http.createServer(async (req, res) => {
    let bytes = 0;
    for await (const chunk of req) bytes += chunk.length;
    calls.push({ bytes, path: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'synthetic', status: 'completed', output: [] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}/v1`;
  let router;
  try {
    router = createRouter({ catalog, codexRoot: root, nativeBase: base, bridgeBase: base, openCodeBase: base,
      allowTestOrigins: true, authenticate: req => req.headers.authorization === 'Bearer synthetic',
      bridgeKey: () => 'synthetic-bridge', historyMode: 'openai', autoBudgetHandoff: false,
      opencodeSoftLimitTokens: 900000, opencodeHardLimitTokens: 1000000,
      onMetric: metric => metrics.push(metric), ...options });
    router.listen(0, '127.0.0.1'); await once(router, 'listening');
  } catch (error) {
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    rmSync(root, { recursive: true, force: true }); throw error;
  }
  return { calls, metrics, base: `http://127.0.0.1:${router.address().port}`,
    async close() {
      for (const server of [router, upstream]) {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      }
      rmSync(root, { recursive: true, force: true });
    } };
}

// Realistic image-shaped but entirely synthetic history. No actual image is used.
export function imageRequest(imageBytes) {
  return { model: 'opencode/test', input: [
    { role: 'developer', content: 'Synthetic instruction.' },
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(imageBytes) }] },
    { role: 'assistant', content: 'Synthetic prior response.' },
    { role: 'user', content: 'Continue.' },
  ] };
}
export function send(base, body, headers = {}) {
  return fetch(base + '/v1/responses', { method: 'POST', headers: {
    authorization: 'Bearer synthetic', 'content-type': 'application/json', ...headers,
  }, body });
}
