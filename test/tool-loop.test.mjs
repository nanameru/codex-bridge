import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createRouter } from '../src/model-router.mjs';
import { repeatedToolCycle } from '../src/tool-adapter.mjs';

function history(count, custom = false) {
  return [{ role: 'user', content: '確認して回答して' }, ...Array.from({ length: count }, (_, i) => [
    { type: 'message', role: 'assistant', content: '確認します' },
    custom ? { type: 'custom_tool_call', name: 'exec', call_id: 'c' + i, input: 'tail log' }
      : { type: 'function_call', name: 'exec', call_id: 'c' + i, arguments: '{"cmd":"tail log","cwd":"/tmp"}' },
    { type: custom ? 'custom_tool_call_output' : 'function_call_output', call_id: 'c' + i, output: 'log changed ' + i },
  ]).flat()];
}

test('six identical completed cycles stop even when logs and call IDs change', () => {
  assert.equal(repeatedToolCycle(history(5)), 0);
  assert.equal(repeatedToolCycle(history(6)), 6);
  assert.equal(repeatedToolCycle(history(12, true)), 12);
});

test('new user, changed arguments and unfinished calls do not trip the guard', () => {
  assert.equal(repeatedToolCycle([...history(8), { role: 'user', content: 'もう一度確認して' }]), 0);
  const changed = history(6);
  changed.at(-2).arguments = '{"cmd":"different command"}';
  assert.equal(repeatedToolCycle(changed), 0);
  const unfinished = history(6).slice(0, -1);
  assert.equal(repeatedToolCycle(unfinished), 0);
  const incomplete = history(6);
  incomplete.at(-1).call_id = 'unmatched';
  assert.equal(repeatedToolCycle(incomplete), 0);
});

test('a parallel batch is one cycle; key order does not affect argument identity', () => {
  const parallel = [{ role: 'user', content: 'parallel' },
    ...Array.from({ length: 8 }, (_, i) => ({ type: 'function_call', name: 'exec', call_id: 'p' + i, arguments: '{}' })),
    ...Array.from({ length: 8 }, (_, i) => ({ type: 'function_call_output', call_id: 'p' + i, output: 'OK' }))];
  assert.equal(repeatedToolCycle(parallel), 0);
  const reordered = history(6);
  reordered.at(-2).arguments = '{ "cwd": "/tmp", "cmd": "tail log" }';
  assert.equal(repeatedToolCycle(reordered), 6);
});

test('router rejects the next generation before any upstream call; native and new user remain usable', async (context) => {
  let calls = 0;
  const router = createRouter({ authenticate: () => true, bridgeKey: () => 'test',
    catalog: { models: [{ slug: 'opencode/test', router_provider: 'opencode' }, { slug: 'gpt-test', router_provider: 'openai' }] },
    fetcher: async () => { calls++; return Response.json({ status: 'completed', output: [] }); } });
  router.listen(0, '127.0.0.1');
  await once(router, 'listening');
  context.after(async () => { router.closeAllConnections(); await new Promise(r => router.close(r)); });
  const input = history(6);
  const original = structuredClone(input);
  const send = (model, input) => fetch(`http://127.0.0.1:${router.address().port}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test' }, body: JSON.stringify({ model, input, stream: true }) });
  const rejected = await send('opencode/test', input);
  assert.equal(rejected.status, 422);
  const error = await rejected.json();
  assert.equal(error.error.type, 'repeated_tool_loop');
  assert.match(error.error.message, /6回/);
  assert.equal(calls, 0);
  assert.deepEqual(input, original);
  assert.equal((await send('opencode/test', [...input, { role: 'user', content: '回答して' }])).status, 200);
  assert.equal((await send('gpt-test', input)).status, 200);
  assert.equal(calls, 2);
});
