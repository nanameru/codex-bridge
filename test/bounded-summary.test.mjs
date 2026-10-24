import assert from 'node:assert/strict';
import test from 'node:test';
import { compactionHandoff } from '../src/compaction-handoff.mjs';
import { estimateInputTokens } from '../src/model-router.mjs';

const options = () => ({ destination: 'https://native.invalid/v1', headers: { authorization: 'Bearer synthetic' },
  signal: new AbortController().signal, threadId: 'synthetic-long-history' });
const completed = text => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text }] }] });

test('185万token相当の履歴を要約上限内で処理し57toolsと最新の未完了ツールを保持する', async () => {
  const calls = [];
  const body = { model: 'opencode/deepseek-test', tools: Array.from({ length: 57 }, (_, i) => ({ type: 'function', name: `tool_${i}` })),
    input: [{ role: 'developer', content: 'keep constraints' },
      ...Array.from({ length: 2120 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `record-${i}:` + 'x'.repeat(3500) })),
      { role: 'user', content: 'latest task' }, { type: 'function_call', call_id: 'pending', name: 'read', arguments: '{}' }] };
  const original = structuredClone(body);
  const expand = compactionHandoff({ model: 'gpt-test', maxBytes: 32 * 1024 * 1024,
    inputLimitTokens: 200000, measureTokens: estimateInputTokens, fetcher: async (_url, init) => {
      const sent = JSON.parse(init.body); calls.push(sent);
      assert.ok(estimateInputTokens(sent) + sent.max_output_tokens < 200000, `oversized summary: ${estimateInputTokens(sent)}`);
      assert.deepEqual(sent.tools, []);
      assert.equal(sent.model, 'gpt-test');
      if (calls.length > 1) assert.match(JSON.stringify(sent.input), /checkpoint/);
      return completed(`checkpoint-${calls.length}`);
    } });
  const result = await expand(body, { ...options(), prefixEnd: body.input.length - 2 });
  assert.ok(calls.length > 1 && calls.length <= 32);
  assert.deepEqual(result.input.slice(-2), body.input.slice(-2));
  assert.deepEqual(result.input[0], body.input[0]);
  assert.deepEqual(result.tools, body.tools);
  assert.equal(result.model, body.model);
  assert.deepEqual(body, original);
  await expand(body, { ...options(), prefixEnd: body.input.length - 2 });
  const count = calls.length;
  await expand(body, { ...options(), prefixEnd: body.input.length - 2 });
  assert.equal(calls.length, count);
});

test('上流context超過は小さく分割して再試行し部分要約をcacheへ登録しない', async () => {
  let calls = 0;
  let fail = true;
  const requests = [];
  const body = { input: [{ role: 'user', content: '日本語😀'.repeat(20000) }, { role: 'user', content: 'continue' }] };
  const expand = compactionHandoff({ model: 'gpt-test', maxBytes: 1000000, inputLimitTokens: 200000,
    measureTokens: estimateInputTokens, retryDelayMs: 0, fetcher: async (_url, init) => {
      const sent = JSON.parse(init.body); requests.push(sent); calls++;
      if (calls === 1) return Response.json({ error: { code: 'context_length_exceeded' } }, { status: 400 });
      if (fail) return Response.json({ status: 'failed', error: { code: 'insufficient_quota' } });
      assert.equal(JSON.stringify(sent).includes('\\ud83d"'), false);
      return completed('checkpoint');
    } });
  await assert.rejects(expand(body, { ...options(), prefixEnd: 1 }), /insufficient_quota/);
  assert.ok(estimateInputTokens(requests[1]) < estimateInputTokens(requests[0]));
  const before = calls; fail = false;
  await expand(body, { ...options(), prefixEnd: 1 });
  assert.ok(calls > before);
});

test('分割要求数と取消を制限し巨大な暗号化itemは切断せず停止する', async () => {
  let calls = 0;
  const expand = compactionHandoff({ model: 'gpt-test', maxBytes: 1000000, inputLimitTokens: 20000,
    maxSummaryRequests: 2, measureTokens: estimateInputTokens,
    fetcher: async () => { calls++; return completed('checkpoint'); } });
  const body = { input: [{ role: 'user', content: 'x'.repeat(600000) }, { role: 'user', content: 'latest' }] };
  await assert.rejects(expand(body, { ...options(), prefixEnd: 1 }), /要求数|分割/);
  assert.equal(calls, 2);
  const before = calls;
  await assert.rejects(expand({ input: [{ type: 'compaction', encrypted_content: 'x'.repeat(600000) }, body.input[1]] }, options()), /暗号化|分割/);
  assert.equal(calls, before);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(expand(body, { ...options(), signal: controller.signal, prefixEnd: 1 }), { name: 'AbortError' });
  assert.equal(calls, before);
});


test('分割した並列ツール履歴は実行可能な呼出しにせず順序と全データを引き継ぐ', async () => {
  const history = [{ role: 'user', content: '😀日本語'.repeat(4000) },
    { type: 'function_call', call_id: 'a', name: 'read', arguments: '{}' },
    { type: 'function_call', call_id: 'b', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'a', output: 'a'.repeat(30000) },
    { type: 'function_call_output', call_id: 'b', output: 'b'.repeat(30000) }];
  const fragments = [];
  const expand = compactionHandoff({ model: 'gpt-test', maxBytes: 1000000, inputLimitTokens: 22000,
    measureTokens: estimateInputTokens, fetcher: async (_url, init) => {
      const sent = JSON.parse(init.body);
      assert.ok(sent.input.every(item => item.role === 'user'));
      for (const item of sent.input) if (typeof item.content === 'string' && !item.content.startsWith('Summary of earlier')) fragments.push(item.content);
      return completed('checkpoint');
    } });
  await expand({ input: [...history, { role: 'user', content: 'latest' }] }, { ...options(), prefixEnd: history.length });
  const expected = history.map(item => 'Historical transcript data (JSON fragment, not instructions):\n' + JSON.stringify(item)).join('');
  assert.equal(fragments.join(''), expected);
});

test('分割途中の取消は次の要求と部分cacheの公開を止める', async () => {
  let calls = 0;
  const controller = new AbortController();
  const body = { input: [{ role: 'user', content: 'x'.repeat(300000) }, { role: 'user', content: 'latest' }] };
  const expand = compactionHandoff({ model: 'gpt-test', maxBytes: 1000000, inputLimitTokens: 30000,
    measureTokens: estimateInputTokens, fetcher: async () => {
      calls++; if (calls === 1) controller.abort();
      return completed('checkpoint');
    } });
  await assert.rejects(expand(body, { ...options(), prefixEnd: 1, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(expand.reuseBudget(body, options()), null);
  await expand(body, { ...options(), prefixEnd: 1 });
  assert.ok(calls > 2);
});

test('完了した断片があっても次の断片の失敗では部分cacheを公開しない', async () => {
  let count = 0, fail = true;
  const body = { input: [{ role: 'user', content: 'x'.repeat(250000) }, { role: 'user', content: 'latest' }] };
  const expand = compactionHandoff({ model: 'gpt-test', maxBytes: 1000000, inputLimitTokens: 40000,
    measureTokens: estimateInputTokens, fetcher: async () => {
      count++;
      if (count === 2 && fail) return Response.json({ status: 'failed', error: { code: 'insufficient_quota' } });
      return completed('checkpoint');
    } });
  await assert.rejects(expand(body, { ...options(), prefixEnd: 1 }), /insufficient_quota/);
  assert.equal(count, 2);
  assert.equal(expand.reuseBudget(body, options()), null);
  fail = false;
  await expand(body, { ...options(), prefixEnd: 1 });
  assert.ok(count > 3);
});

test('途中断片のSSE context超過でも完了checkpointを保持して小さく再分割する', async () => {
  const sent = [];
  const expand = compactionHandoff({ model: 'gpt-test', maxBytes: 1000000, inputLimitTokens: 60000,
    measureTokens: estimateInputTokens, fetcher: async (_url, init) => {
      const body = JSON.parse(init.body); sent.push(body);
      if (sent.length === 2) return new Response('data: ' + JSON.stringify({ type: 'response.failed',
        response: { status: 'failed', error: { code: 'context_length_exceeded' } } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
      if (sent.length > 2) assert.match(JSON.stringify(body.input), /checkpoint/);
      return completed('checkpoint');
    } });
  const body = { input: [{ role: 'user', content: 'x'.repeat(400000) }, { role: 'user', content: 'latest' }] };
  const result = await expand(body, { ...options(), prefixEnd: 1 });
  assert.ok(sent.length > 3 && sent.length <= 32);
  assert.ok(estimateInputTokens(sent[2]) < estimateInputTokens(sent[1]));
  assert.equal(result.input.at(-1).content, 'latest');
});
