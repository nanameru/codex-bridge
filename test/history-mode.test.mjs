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
  const send = (body = request, token = 'owner-native-token', path = '/v1/responses', extraHeaders = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });
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
  const second = await f.send(next); const secondText = await second.text();
  assert.equal(second.status, 200, secondText);
  assert.doesNotMatch(secondText, /保存された会話ログを|msg_bridge_handoff_provider_/);
  assert.equal(f.calls.length, 3, 'successful portable prefix avoids repeated log reads and summaries');
  assert.equal(f.metrics[1].history_source, 'portable_prefix_cache');
  assert.match(JSON.stringify(f.calls.at(-1).body), /NEXT REQUEST/);
  const rotated = await f.send(request, 'new-owner-token'); assert.equal(rotated.status, 200, await rotated.text());
  assert.equal(f.calls.length, 5, 'owner authentication change cannot reuse another cache scope');
  const other = await f.send({ ...request, prompt_cache_key: '01a1777d-4508-72a1-9dbe-dcd799f721aa' });
  assert.equal(other.status, 422); await other.text(); assert.equal(f.calls.length, 5);
});

test('native fork restores only an exact checkpoint independently present in its parent', async t => {
  const root = home(t), parent = '01a1777d-4508-72a1-9dbe-dcd799f721ac';
  const childPath = rollout(root);
  const parentPath = childPath.replace(thread, parent);
  writeFileSync(parentPath, readFileSync(childPath, 'utf8').replaceAll(thread, parent), { mode: 0o600 });
  const childEvents = [
    { type: 'session_meta', payload: { id: thread, forked_from_id: parent } },
    { type: 'session_meta', payload: { id: parent } },
    { type: 'compacted', payload: { replacement_history: [opaque] } },
  ];
  const save = events => writeFileSync(childPath, events.map(JSON.stringify).join('\n') + '\n');
  save(childEvents);
  const before = readFileSync(childPath, 'utf8');
  const restored = await restoreRolloutHistory(request, { root, threadId: thread });
  assert.equal(restored.body.input.at(-1).content, 'LATEST REQUEST');
  assert.ok(restored.body.input.some(x => x.type === 'function_call_output'));
  assert.equal(restored.body.input[0].content, 'KEEP CURRENT INSTRUCTIONS');
  assert.equal(readFileSync(childPath, 'utf8'), before);
  const f = await fixture(t, { codexRoot: root });
  const response = await f.send();
  assert.equal(response.status, 200, await response.text());
  assert.equal(f.metrics.at(-1).history_source, 'owner_rollout');
  assert.match(JSON.stringify(f.calls.at(-1).body), /LATEST REQUEST/);
  for (const events of [
    [childEvents[0], { type: 'session_meta', payload: { id: thread } }, childEvents[2]],
    [...childEvents, childEvents[1]],
    [...childEvents, { type: 'event_msg', payload: { type: 'thread_rolled_back' } }],
    [childEvents[0], childEvents[1], { type: 'compacted', payload: { replacement_history: [{ ...opaque, encrypted_content: 'other' }] } }],
  ]) {
    save(events);
    await assert.rejects(restoreRolloutHistory(request, { root, threadId: thread }));
  }
  save(childEvents);
  const parentOriginal = readFileSync(parentPath, 'utf8');
  writeFileSync(parentPath, parentOriginal.replaceAll('opaque-history', 'different-parent-checkpoint'));
  await assert.rejects(restoreRolloutHistory(request, { root, threadId: thread }));
  writeFileSync(parentPath, JSON.stringify({ type: 'session_meta', payload: { id: parent, forked_from_id: thread } }) + '\n' +
    JSON.stringify(childEvents[2]) + '\n');
  await assert.rejects(restoreRolloutHistory(request, { root, threadId: thread }));
  rmSync(parentPath);
  await assert.rejects(restoreRolloutHistory(request, { root, threadId: thread }));
});

test('paginated fork restores only the parent prefix and retains child input', async t => {
  const root = home(t), parent = '01a1777d-4508-72a1-9dbe-dcd799f721ac';
  const childPath = rollout(root), parentPath = childPath.replace(thread, parent);
  const parentPrefix = readFileSync(childPath, 'utf8').replaceAll(thread, parent);
  const offset = Buffer.byteLength(parentPrefix), ordinal = parentPrefix.split('\n').length - 1;
  const suffix = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'AFTER FORK SECRET' } }) + '\n';
  writeFileSync(parentPath, parentPrefix + suffix, { mode: 0o600 });
  const childMessage = { type: 'message', role: 'user', content: 'CHILD REQUIREMENT' };
  const base = { thread_id: parent, end_byte_offset: offset, end_ordinal_exclusive: ordinal };
  const save = history_base => writeFileSync(childPath, [
    { type: 'session_meta', payload: { id: thread, forked_from_id: parent, history_mode: 'paginated',
      forked_from_ordinal_exclusive: ordinal, history_base } },
    { type: 'response_item', payload: childMessage },
  ].map(JSON.stringify).join('\n') + '\n');
  const body = { ...request, input: [request.input[0], opaque, childMessage, request.input.at(-1)] };
  save(base);
  const restored = await restoreRolloutHistory(body, { root, threadId: thread });
  assert.match(JSON.stringify(restored.body.input), /ORIGINAL REQUIREMENT/);
  assert.match(JSON.stringify(restored.body.input), /CHILD REQUIREMENT/);
  assert.doesNotMatch(JSON.stringify(restored.body.input), /AFTER FORK SECRET/);
  for (const invalid of [
    { ...base, thread_id: thread }, { ...base, end_byte_offset: offset - 1 },
    { ...base, end_byte_offset: offset + Buffer.byteLength(suffix) + 1 },
    { ...base, end_ordinal_exclusive: ordinal + 1 },
  ]) {
    save(invalid);
    await assert.rejects(restoreRolloutHistory(body, { root, threadId: thread }));
  }
  save(base);
  await assert.rejects(restoreRolloutHistory(request, { root, threadId: thread }), e => e.reason === 'invalid_checkpoint');
  const later = { ...opaque, encrypted_content: 'after-fork-checkpoint' };
  appendFileSync(parentPath, JSON.stringify({ type: 'compacted', payload: { replacement_history: [later] } }) + '\n');
  await assert.rejects(restoreRolloutHistory({ ...body, input: [body.input[0], later, childMessage] }, { root, threadId: thread }));
});

test('fork ancestry has a fixed depth bound even when every checkpoint matches', async t => {
  const root = home(t), first = rollout(root);
  const original = readFileSync(first, 'utf8');
  const ids = [thread, ...Array.from({ length: 8 }, (_, i) => `01a1777d-4508-72a1-9dbe-${String(i).padStart(12, '0')}`)];
  for (let i = 0; i < ids.length; i++) {
    const file = first.replace(thread, ids[i]);
    writeFileSync(file, i === ids.length - 1 ? original.replaceAll(thread, ids[i]) : [
      { type: 'session_meta', payload: { id: ids[i], forked_from_id: ids[i + 1] } },
      { type: 'compacted', payload: { replacement_history: [opaque] } },
    ].map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
  }
  await assert.rejects(restoreRolloutHistory(request, { root, threadId: thread }));
  const withinLimit = await restoreRolloutHistory(request, { root, threadId: ids[1] });
  assert.ok(withinLimit.body.input.some(x => x.type === 'function_call_output'));
});

test('owner session ID takes precedence over unrelated prompt cache identifiers', async t => {
  for (const cacheKey of ['prefix-cache-not-a-thread', '01a1777d-4508-72a1-9dbe-dcd799f721aa']) {
    const f = await fixture(t);
    rollout(f.root);
    const body = { ...request, prompt_cache_key: cacheKey };
    const response = await f.send(body, 'owner-native-token', '/v1/responses', { session_id: thread });
    assert.equal(response.status, 200, await response.text());
    assert.equal(f.metrics[0].history_source, 'owner_rollout');
    assert.ok(f.calls.every(call => call.url.includes('9997')));
    assert.equal(f.calls.at(-1).body.prompt_cache_key, cacheKey);
  }
});

test('current Codex thread identity restores history independently of cache routing', async t => {
  const affinity = '01a1777d-4508-72a1-9dbe-dcd799f721aa';
  for (const [extraHeaders, metadata, source] of [
    [{ 'thread-id': thread, 'session-id': affinity, session_id: affinity }, {}, 'thread_header'],
    [{ 'session-id': affinity }, { 'x-codex-turn-metadata': JSON.stringify({ session_id: thread }) }, 'turn_metadata'],
    [{ 'session-id': thread }, {}, 'session_header'],
  ]) {
    const f = await fixture(t); rollout(f.root);
    const body = { ...request, prompt_cache_key: affinity, client_metadata: metadata };
    const response = await f.send(body, 'owner-native-token', '/v1/responses', extraHeaders);
    assert.equal(response.status, 200, await response.text());
    assert.equal(f.metrics[0].history_identity_source, source);
    assert.equal(f.metrics[0].history_source, 'owner_rollout');
    assert.ok(f.calls.every(call => call.url.includes('9997')));
    assert.match(JSON.stringify(f.calls[0].body), /ORIGINAL REQUIREMENT/);
    assert.match(JSON.stringify(f.calls.at(-1).body), /LATEST REQUEST/);
    assert.equal(f.calls.at(-1).body.prompt_cache_key, affinity);
  }
});

test('restore rejection records only a fixed reason and never falls back to another chat', async t => {
  const f = await fixture(t); rollout(f.root);
  const other = '01a1777d-4508-72a1-9dbe-dcd799f721aa';
  const response = await f.send(request, 'owner-native-token', '/v1/responses', { 'thread-id': other });
  assert.equal(response.status, 422);
  assert.equal(f.calls.length, 0);
  assert.equal(f.metrics[0].history_identity_source, 'thread_header');
  assert.equal(f.metrics[0].history_restore_reason, 'log_not_found');
  const diagnostic = JSON.stringify(f.metrics[0]);
  assert.doesNotMatch(diagnostic, /ORIGINAL REQUIREMENT|opaque-history|owner-native-token/);
  assert.ok(!diagnostic.includes(f.root) && !diagnostic.includes(other));
  assert.doesNotMatch(await response.text(), /ORIGINAL REQUIREMENT|opaque-history/);
});

test('OpenAI handoff cache hits stay quiet and changed authentication still notifies', async t => {
  const f = await fixture(t, { historyMode: 'openai' });
  const first = await f.send();
  assert.equal(first.status, 200);
  assert.match(await first.text(), /追加の利用量/);
  const next = { ...request, input: [...request.input, { role: 'assistant', content: 'ANSWER' },
    { role: 'user', content: 'NEXT REQUEST' }] };
  const second = await f.send(next);
  assert.equal(second.status, 200);
  assert.doesNotMatch(await second.text(), /msg_bridge_handoff_provider_/);
  assert.equal(f.metrics.at(-1).summary_cache, 'hit');
  assert.equal(f.calls.length, 3);
  const changed = await f.send(next, 'changed-owner-token');
  assert.equal(changed.status, 200);
  assert.match(await changed.text(), /追加の利用量/);
  assert.equal(f.calls.length, 5);
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

test('large checkpoint continuation reuses the portable prefix without repeating the notice or reading the rollout', async t => {
  let restores = 0;
  const f = await fixture(t, { restoreHistory: async body => {
    restores++;
    return { body: { ...body, input: [{ role: 'user', content: 'x'.repeat(9 * 1024 * 1024) },
      ...body.input.slice(-1)] }, prefixEnd: 1 };
  } });
  const first = await f.send();
  assert.equal(first.status, 200);
  assert.match(await first.text(), /暗号化履歴の読み取り/);
  const continued = { ...request, input: [...request.input,
    { role: 'user', content: 'NEW REQUEST MUST SURVIVE' }] };
  const second = await f.send(continued);
  assert.equal(second.status, 200);
  assert.doesNotMatch(await second.text(), /暗号化履歴の読み取り|msg_bridge_handoff_provider_/);
  assert.equal(restores, 1);
  assert.equal(f.calls.filter(c => c.body.model === 'gpt-test').length, 1);
  assert.equal(f.metrics.at(-1).history_source, 'portable_prefix_cache');
  assert.match(JSON.stringify(f.calls.at(-1).body), /NEW REQUEST MUST SURVIVE/);
  const changed = await f.send({ ...continued, input: continued.input.map(i => i === opaque
    ? { ...opaque, encrypted_content: 'changed-checkpoint' } : i) });
  assert.equal(changed.status, 200); await changed.text();
  assert.equal(restores, 2);
  const otherOwner = await f.send(continued, 'different-owner');
  assert.equal(otherOwner.status, 200); await otherOwner.text();
  assert.equal(restores, 3);
});

test('restored checkpoint reuses its budget summary across growing tool continuations', async t => {
  for (const large of [true, false]) {
    const f = await fixture(t, { opencodeSoftLimitTokens: 1800, opencodeHardLimitTokens: 4000,
      restoreHistory: async body => ({ body: { ...body, input: [body.input[0],
        { role: 'user', content: large ? 'x'.repeat(9 * 1024 * 1024) : 'original history' },
        ...body.input.slice(2)] }, prefixEnd: 2 }) });
    const call = id => ({ type: 'function_call', call_id: id, name: 'read', arguments: '{}' });
    const output = (id, text = 'small result') => ({ type: 'function_call_output', call_id: id, output: text });
    const input = [...request.input, call('old'), output('old', 'evidence '.repeat(2500)),
      call('recent'), output('recent'), call('pending')];
    const send = async (items, token) => {
      const response = await f.send({ ...request, input: items }, token);
      const text = await response.text();
      assert.equal(response.status, 200, text);
      return text;
    };
    assert.match(await send(input), /保存された会話ログを/);
    const summaryCount = () => f.calls.filter(c => c.body.instructions?.startsWith('Produce only')).length;
    const initialSummaries = summaryCount();
    assert.equal(initialSummaries, 2);
    for (let index = 0; index < 3; index++) {
      const next = 'pending-' + index;
      input.push(output(index ? 'pending-' + (index - 1) : 'pending'), call(next));
      assert.doesNotMatch(await send(input), /保存された会話ログを|暗号化履歴の読み取り/);
      assert.equal(summaryCount(), initialSummaries, 'short tool suffix must reuse the completed budget summary');
      assert.equal(f.metrics.at(-1).budget_prefix_cache, 'hit');
      const forwarded = JSON.stringify(f.calls.at(-1).body);
      assert.match(forwarded, /LATEST REQUEST/);
      assert.match(forwarded, /KEEP CURRENT INSTRUCTIONS/);
      assert.ok(forwarded.includes(next), 'unresolved tool call survives');
    }
    input.push(output('pending-2', 'new evidence '.repeat(2500)), call('last'), output('last'), call('next'));
    assert.match(await send(input), /保存された会話ログを/);
    assert.ok(summaryCount() > initialSummaries, 'growing suffix still triggers necessary compaction');
    const beforeRotation = summaryCount();
    await send(input, 'rotated-owner');
    assert.ok(summaryCount() > beforeRotation, 'authentication scope stays isolated');
  }
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

test('末尾checkpointは単一依頼を捨てずに復元し、要約不能なら全履歴を保持する', async t => {
  const root=home(t), path=rollout(root), before=readFileSync(path,'utf8');
  const restored=await restoreRolloutHistory({...request,input:request.input.slice(0,-1)},{root,threadId:thread});
  assert.equal(restored.prefixEnd,undefined);
  assert.ok(restored.body.input.some(i=>i.content==='ORIGINAL REQUIREMENT'));
  assert.ok(restored.body.input.some(i=>i.output==='ORIGINAL TOOL RESULT'));
  assert.equal(restored.body.input.some(i=>i.type==='compaction'),false);
  assert.equal(readFileSync(path,'utf8'),before);
});

test('末尾checkpointでは最新依頼とそのツール結果を要約suffixに保持する',async t=>{
  const root=home(t);rollout(root,{before:[
    {type:'response_item',payload:{type:'message',role:'user',content:'LATEST TASK'}},
    {type:'response_item',payload:{type:'function_call',call_id:'recent',name:'read',arguments:'{}'}},
    {type:'response_item',payload:{type:'function_call_output',call_id:'recent',output:'LATEST TOOL RESULT'}},
  ]});
  const r=await restoreRolloutHistory({...request,input:[opaque]},{root,threadId:thread});
  assert.ok(r.prefixEnd>0&&r.prefixEnd<r.body.input.length);
  assert.equal(r.body.input[r.prefixEnd].content,'LATEST TASK');
  assert.equal(r.body.input.at(-1).output,'LATEST TOOL RESULT');
});

test('末尾checkpointの通常ルーター経由で422にせず同じモデルが応答する',async t=>{
  const f=await fixture(t);rollout(f.root);
  const response=await f.send({...request,input:request.input.slice(0,-1)});
  assert.equal(response.status,200,await response.text());
  assert.equal(f.calls.length,1);
  assert.ok(f.calls[0].body.input.some(i=>i.content==='ORIGINAL REQUIREMENT'));
  assert.ok(f.calls[0].body.input.some(i=>i.output==='ORIGINAL TOOL RESULT'));
});
