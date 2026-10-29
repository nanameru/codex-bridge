import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, truncateSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { HISTORY_MODES, readHistoryMode, writeHistoryMode } from '../src/history-mode.mjs';
import { restoreRolloutHistory } from '../src/rollout-history.mjs';
import { createRouter } from '../src/model-router.mjs';
import { KIMI_SLUG } from '../src/manual-providers.mjs';

const thread = '01a1777d-4508-72a1-9dbe-dcd799f721ab';
const catalog = { models: [
  { slug: 'gpt-test', router_provider: 'openai' },
  { slug: 'opencode/deepseek-test', router_model: 'deepseek-test', router_provider: 'opencode', context_window: 200000 },
] };
const opaque = { type: 'compaction', encrypted_content: 'opaque-history' };
const request = { model: 'opencode/deepseek-test', prompt_cache_key: thread, stream: false,
  input: [{ type: 'message', role: 'developer', content: 'KEEP CURRENT INSTRUCTIONS' }, opaque,
    { type: 'message', role: 'user', content: 'LATEST REQUEST' }] };
const result = text => Response.json({ id: 'resp_test', status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] });
function home(t) {
  const root = mkdtempSync(join(tmpdir(), 'history-modes-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
function rollout(root, changes = {}) {
  const directory = join(root, 'sessions', '2026', '10', '27');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const events = [
    { type: 'session_meta', payload: { id: thread, ...changes.meta } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: 'ORIGINAL REQUIREMENT' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'ORIGINAL TOOL RESULT' } },
    { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'opaque-reasoning' } },
    ...(changes.before ?? []),
    { type: 'compacted', payload: { replacement_history: [opaque] } },
  ];
  const path = join(directory, `rollout-date-${thread}.jsonl`);
  writeFileSync(path, events.map(value => JSON.stringify(value)).join('\n') + '\n', { mode: 0o600 });
  return path;
}
async function fixture(t, options = {}) {
  const root = options.codexRoot ?? home(t), calls = [], metrics = [];
  const server = createRouter({ catalog, codexRoot: root, authenticate: () => true,
    bridgeKey: () => 'internal-key', summaryModel: 'gpt-test', allowTestOrigins: true,
    nativeBase: 'http://127.0.0.1:9998/v1', bridgeBase: 'http://127.0.0.1:9997/v1',
    onMetric: metric => metrics.push(metric),
    fetcher: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, headers: options.headers, body });
      return result(body.instructions?.startsWith('Produce only') ? 'PORTABLE SUMMARY' : 'ANSWER');
    }, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const send = (body = request, token = 'owner-native-token', path = '/v1/responses') => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { root, calls, metrics, send };
}

test('mode CLI defaults to selected, shows loss warning, and writes private owner settings', t => {
  const root = home(t), env = { ...process.env, CODEX_HOME: root };
  assert.equal(readHistoryMode(root), 'selected');
  const show = () => execFileSync(process.execPath, ['src/history-mode.mjs'], { env, encoding: 'utf8' });
  assert.match(show(), /過去の指示・判断・細部/);
  for (const mode of ['openai', 'ask', 'selected']) {
    execFileSync(process.execPath, ['src/history-mode.mjs', '--mode', mode], { env });
    assert.equal(readHistoryMode(root), mode);
  }
  assert.equal(statSync(join(root, 'bridge-history-mode.json')).mode & 0o777, 0o600);
  assert.match(HISTORY_MODES.openai.notice, /追加の利用量/);
});

test('production summary override keeps cheap GPT compaction and selected external requests separate', async t => {
  const previous = process.env.CODEX_SUMMARY_MODEL;
  process.env.CODEX_SUMMARY_MODEL = 'gpt-cheap';
  t.after(() => { if (previous === undefined) delete process.env.CODEX_SUMMARY_MODEL; else process.env.CODEX_SUMMARY_MODEL = previous; });
  const { calls, send, root } = await fixture(t, { summaryModel: undefined, catalog: { models: [
    ...catalog.models, { slug: 'gpt-cheap', router_provider: 'openai' },
  ] } });
  const input = [{ role: 'user', content: 'keep facts' }, { type: 'compaction_trigger' }];
  const native = await send({ model: 'gpt-test', input });
  assert.equal(native.status, 200, await native.text());
  assert.equal(calls.at(-1).body.model, 'gpt-cheap');
  const count = calls.length;
  const external = await send({ model: 'opencode/deepseek-test', input });
  assert.equal(external.status, 200, await external.text());
  assert.equal(calls.length, count + 1); // Legacy wire compaction uses the native summary only.
  const normal = await send({ model: 'gpt-test', input: [{ role: 'user', content: 'continue' }] });
  assert.equal(normal.status, 200, await normal.text());
  assert.equal(calls.at(-1).body.model, 'gpt-test');
  assert.equal(readHistoryMode(root), 'selected');
});

test('mode settings reject unsafe roots, symlinks, public files and unknown modes', t => {
  const root = home(t);
  assert.throws(() => writeHistoryMode(root, '__proto__'));
  writeHistoryMode(root, 'ask');
  chmodSync(join(root, 'bridge-history-mode.json'), 0o644);
  assert.throws(() => readHistoryMode(root));
  chmodSync(join(root, 'bridge-history-mode.json'), 0o600);
  writeFileSync(join(root, 'other'), '{"version":1,"mode":"openai"}', { mode: 0o600 });
  rmSync(join(root, 'bridge-history-mode.json'));
  symlinkSync(join(root, 'other'), join(root, 'bridge-history-mode.json'));
  assert.throws(() => writeHistoryMode(root, 'selected'));
  const unsafe = home(t); chmodSync(unsafe, 0o777);
  assert.throws(() => writeHistoryMode(unsafe, 'openai'));
});

test('raw restore matches the exact checkpoint, keeps tools and current directives, and never edits originals', async t => {
  const root = home(t), path = rollout(root), original = readFileSync(path, 'utf8');
  const restored = await restoreRolloutHistory(request, { root, threadId: thread });
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(restored.body.input[0].content, 'KEEP CURRENT INSTRUCTIONS');
  assert.equal(restored.body.input.at(-1).content, 'LATEST REQUEST');
  assert.ok(restored.body.input.some(item => item.type === 'function_call_output'));
  assert.ok(!restored.body.input.some(item => ['compaction', 'reasoning'].includes(item.type)));
  assert.ok(restored.prefixEnd < restored.body.input.length);
});

test('raw restore stops on missing history, wrong IDs, forks, rollback, malformed logs and unsafe paths', async t => {
  for (const variant of ['missing', 'wrong-thread', 'wrong-checkpoint', 'fork', 'rollback', 'invalid', 'symlink', 'directory-link', 'duplicate']) {
    const root = home(t);
    let path;
    if (variant !== 'missing') path = rollout(root, variant === 'fork' ? { meta: { forked_from_id: 'parent' } }
      : variant === 'rollback' ? { before: [{ type: 'event_msg', payload: { type: 'thread_rolled_back' } }] } : {});
    if (variant === 'invalid') writeFileSync(path, 'PRIVATE SOURCE INVALID JSON');
    if (variant === 'symlink') { const source = path + '.source'; writeFileSync(source, readFileSync(path)); rmSync(path); symlinkSync(source, path); }
    if (variant === 'directory-link') { rmSync(path); rmSync(join(root, 'sessions'), { recursive: true }); symlinkSync(root, join(root, 'sessions')); }
    if (variant === 'duplicate') writeFileSync(path.replace('date-', 'duplicate-'), readFileSync(path), { mode: 0o600 });
    const body = variant === 'wrong-checkpoint' ? { ...request, input: [{ ...opaque, encrypted_content: 'different' }, request.input.at(-1)] } : request;
    await assert.rejects(restoreRolloutHistory(body, { root, threadId: variant === 'wrong-thread' ? '../other' : thread }), error => {
      assert.match(error.message, /OpenAIは使用していません/); assert.doesNotMatch(error.message, /PRIVATE SOURCE/); return true;
    }, variant);
  }
});

test('default selected mode reconstructs opaque history and calls only the selected external model', async t => {
  const f = await fixture(t); const path = rollout(f.root), original = readFileSync(path, 'utf8');
  const response = await f.send(); const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.url.startsWith('http://127.0.0.1:9997/')));
  assert.ok(f.calls.every(call => call.body.model === 'deepseek-test'));
  assert.ok(f.calls.every(call => !JSON.stringify(call.headers).includes('owner-native-token')));
  assert.match(JSON.stringify(f.calls[0].body), /ORIGINAL REQUIREMENT/);
  assert.doesNotMatch(JSON.stringify(f.calls), /opaque-history|opaque-reasoning/);
  assert.match(text, /過去の指示・判断・細部/);
  assert.match(JSON.stringify(f.calls[1].body), /KEEP CURRENT INSTRUCTIONS|LATEST REQUEST/);
  assert.equal(f.metrics[0].history_source, 'owner_rollout');
  assert.equal(readFileSync(path, 'utf8'), original);
  const next = { ...request, input: [...request.input, { role: 'assistant', content: 'ANSWER' }, { role: 'user', content: 'NEXT REQUEST' }] };
  const second = await f.send(next); assert.equal(second.status, 200, await second.text());
  assert.equal(f.calls.length, 3, 'successful portable prefix avoids repeated log reads and summaries');
  assert.equal(f.metrics[1].history_source, 'portable_prefix_cache');
  assert.match(JSON.stringify(f.calls.at(-1).body), /NEXT REQUEST/);
  const rotated = await f.send(request, 'new-owner-token'); assert.equal(rotated.status, 200, await rotated.text());
  assert.equal(f.calls.length, 5, 'owner authentication change cannot reuse another cache scope');
  const other = await f.send({ ...request, prompt_cache_key: '01a1777d-4508-72a1-9dbe-dcd799f721aa' });
  assert.equal(other.status, 422); await other.text(); assert.equal(f.calls.length, 5);
});

test('DeepSeek and Kimi auxiliary summaries use only their selected Command Code or Ollama credentials', async t => {
  for (const model of ['commandcode/deepseek-v4.1-flash', 'ollama/deepseek-v4.1-flash', KIMI_SLUG]) {
    const calls = [];
    const f = await fixture(t, { manualProvidersEnabled: true, manualKey: () => 'external-key',
      fetcher: async (url, options) => {
        const body = JSON.parse(options.body); calls.push({ url, body, headers: options.headers });
        if (body.stream) return new Response([
          { choices: [{ index: 0, delta: { role: 'assistant', content: 'SELECTED MODEL SUMMARY' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ].map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
        return Response.json({ id: 'chat_test', object: 'chat.completion', choices: [{ index: 0,
          message: { role: 'assistant', content: 'SELECTED MODEL SUMMARY' }, finish_reason: 'stop' }] });
      } });
    rollout(f.root);
    const response = await f.send({ ...request, model });
    assert.equal(response.status, 200, await response.text());
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.url.startsWith(model.startsWith('ollama/') ? 'https://ollama.com/' : 'https://api.commandcode.ai/')));
    assert.ok(calls.every(call => call.headers.authorization === 'Bearer external-key'));
    assert.doesNotMatch(JSON.stringify(calls), /owner-native-token|opaque-history|opaque-reasoning/);
    assert.equal(calls[0].body.model, model === KIMI_SLUG ? 'moonshotai/Kimi-K3.1-Pro'
      : model.startsWith('ollama/') ? 'deepseek-v4.1-flash' : 'deepseek/deepseek-v4.1-flash');
  }
});

test('missing originals and ask mode stop before any upstream request; changing mode is live', async t => {
  const f = await fixture(t);
  let response = await f.send(); assert.equal(response.status, 422); await response.text();
  assert.equal(f.calls.length, 0);
  writeHistoryMode(f.root, 'ask');
  response = await f.send(); assert.equal(response.status, 422);
  assert.match(await response.text(), /history_mode_confirmation_required/); assert.equal(f.calls.length, 0);
  writeHistoryMode(f.root, 'openai');
  response = await f.send(); assert.equal(response.status, 200, await response.text());
  assert.match(f.calls[0].url, /9998/);
  assert.equal(f.calls[0].body.model, 'gpt-test');
  assert.equal(f.calls[0].headers.authorization, 'Bearer owner-native-token');
});

test('legacy external remote compaction uses the native wire model; ask mode still stops', async t => {
  for (const mode of ['selected', 'ask']) {
    const f = await fixture(t, { historyMode: mode });
    const response = await f.send({ ...request, input: [{ role: 'user', content: 'continue' }, { type: 'compaction_trigger' }] });
    assert.equal(response.status, mode === 'ask' ? 422 : 200);
    await response.text();
    assert.equal(f.calls.length, mode === 'ask' ? 0 : 1);
    if (mode === 'selected') {
      assert.match(f.calls[0].url, /9998/);
      assert.equal(f.calls[0].body.model, 'gpt-test');
      assert.equal(f.metrics.at(-1).remote_compaction_fallback, 'openai');
      const next = await f.send({ ...request, input: [{ role: 'user', content: 'next turn' }] });
      assert.equal(next.status, 200); await next.text();
      assert.equal(f.calls.at(-1).body.model, 'deepseek-test');
    }
  }
});

test('plaintext budget summaries use the external model and ask mode stops without a request', async t => {
  for (const mode of ['selected', 'ask']) {
    const f = await fixture(t, { historyMode: mode, opencodeSoftLimitTokens: 2500, opencodeHardLimitTokens: 5000 });
    const input = [
      { type: 'message', role: 'user', content: 'OLD '.repeat(6000) },
      { type: 'message', role: 'assistant', content: 'OLD RESULT' },
      { type: 'message', role: 'user', content: 'LATEST REQUEST' },
    ];
    const response = await f.send({ ...request, input }); const text = await response.text();
    assert.equal(response.status, mode === 'ask' ? 422 : 200, text);
    if (mode === 'ask') assert.equal(f.calls.length, 0);
    else {
      assert.equal(f.calls.length, 2);
      assert.ok(f.calls.every(call => call.url.includes('9997')));
      assert.match(JSON.stringify(f.calls.at(-1).body), /LATEST REQUEST/);
    }
  }
});

test('selected whatstoken stops with actionable 422 when auxiliary summaries are required', async t => {
  const options = {
    historyMode: 'selected',
    manualProvidersEnabled: true,
    whatstokenFreeEnabled: true,
    manualKey: provider => provider === 'whatstoken' ? 'whatstoken-key' : 'external-key',
    whatstokenFreeGate: { check: async () => ({ allowed: true, end: Date.now() + 3600000 }), unavailable() {} },
    opencodeSoftLimitTokens: 2500,
    opencodeHardLimitTokens: 5000,
  };
  const model = 'auto-whatstoken/deepseek-v4.1-flash';

  const budget = await fixture(t, options);
  const largeInput = [
    { type: 'message', role: 'user', content: 'OLD '.repeat(6000) },
    { type: 'message', role: 'assistant', content: 'OLD RESULT' },
    { type: 'message', role: 'user', content: 'LATEST REQUEST' },
  ];
  let response = await budget.send({ ...request, model, input: largeInput });
  let text = await response.text();
  assert.equal(response.status, 422, text);
  assert.match(text, /history_mode_summary_unsupported/);
  assert.match(text, /OpenCode・Command Code・Ollama/);
  assert.equal(budget.calls.length, 0);

  const compacted = await fixture(t, options);
  rollout(compacted.root);
  response = await compacted.send({ ...request, model });
  text = await response.text();
  assert.equal(response.status, 422, text);
  assert.match(text, /history_mode_summary_unsupported/);
  assert.match(text, /履歴は保持しています/);
  assert.equal(compacted.calls.length, 0);
});

test('large owner logs stream past 64MiB without accepting oversized files or a later rollback', async t => {
  const root = home(t), path = rollout(root);
  // Large logs commonly contain duplicate event_msg records outside response history.
  const padding = JSON.stringify({ type: 'event_msg', payload: { text: 'x'.repeat(1024 * 1024) } }) + '\n';
  for (let i = 0; i < 66; i++) appendFileSync(path, padding);
  const restored = await restoreRolloutHistory(request, { root, threadId: thread });
  assert.ok(restored.body.input.some(item => item.content === 'ORIGINAL REQUIREMENT'));
  appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: { type: 'thread_rolled_back' } }) + '\n');
  await assert.rejects(restoreRolloutHistory(request, { root, threadId: thread }));
  truncateSync(path, 512 * 1024 * 1024 + 1);
  await assert.rejects(restoreRolloutHistory(request, { root, threadId: thread }));
});

test('large restored histories use only the native checkpoint then continue on OpenCode', async t => {
  const f = await fixture(t, { restoreHistory: async body => ({ body: { ...body,
    input: [{ role: 'user', content: 'x'.repeat(9 * 1024 * 1024) }, ...body.input.slice(-1)] }, prefixEnd: 1 }) });
  const response = await f.send();
  assert.equal(response.status, 200, await response.text());
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].body.model, 'gpt-test');
  assert.ok(f.calls[0].body.input.some(item => item.encrypted_content === opaque.encrypted_content));
  assert.ok(JSON.stringify(f.calls[0].body).length < 10000);
  assert.equal(f.calls[1].body.model, 'deepseek-test');
  assert.ok(!f.calls[1].body.input.some(item => item.type === 'compaction'));
  assert.equal(f.metrics.at(-1).history_source, 'native_checkpoint');
});

test('legacy compact endpoint uses the native model without changing selected mode', async t => {
  const f = await fixture(t, { historyMode: 'selected' });
  const response = await f.send({ model: request.model, input: [{ role: 'user', content: 'remember' }] },
    'owner-native-token', '/v1/responses/compact');
  assert.equal(response.status, 200, await response.text());
  assert.match(f.calls[0].url, /9998\/v1\/responses\/compact$/);
  assert.equal(f.calls[0].body.model, 'gpt-test');
  assert.equal(readHistoryMode(f.root), 'selected');
});

test('native remote compaction SSE remains valid when upstream omits content-type', async t => {
  const f = await fixture(t, { fetcher: async () => new Response(Buffer.from(
    'event: response.output_item.done\ndata: '+JSON.stringify({ type: 'response.output_item.done', output_index: 0,
      item: {type: 'compaction', encrypted_content: 'native-summary'} })+'\n\n'
    +'event: response.completed\ndata: '+JSON.stringify({ type: 'response.completed', response: {status: 'completed',output: []} })+'\n\n')) });
  const response = await f.send({ model: request.model, stream: true, input: [{ role: 'user', content: 'remember' }, {type:'compaction_trigger'}] });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.match(await response.text(), /native-summary/);
});
