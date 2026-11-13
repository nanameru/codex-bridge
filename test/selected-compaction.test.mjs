// Issue #186: the selected model writes the compaction while OpenAI is at its usage limit.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRouter } from '../src/model-router.mjs';
import { MANUAL_PROVIDERS } from '../src/manual-providers.mjs';
import { ProviderFallbackState } from '../src/provider-fallback.mjs';
import { SELECTED_COMPACTION_NOTICE, SELECTED_COMPACTION_PREFIX, SummaryLimitWindow, containsSelectedCompaction,
  encodeSelectedCompaction, restoreSelectedCompactions, selectedCompactionResponse } from '../src/selected-compaction.mjs';

const thread = '01a1777d-4508-72a1-9dbe-dcd799f721ab';
const catalog = { models: [
  { slug: 'gpt-test', router_provider: 'openai' },
  { slug: 'opencode/deepseek-test', router_model: 'deepseek-test', router_provider: 'opencode', context_window: 200000 },
] };
const SECRET_TEXT = 'PRIVATE CONVERSATION BODY';
const trigger = { type: 'compaction_trigger' };
const compactionRequest = (extra = {}) => ({ model: 'opencode/deepseek-test', prompt_cache_key: thread, stream: true,
  input: [{ type: 'message', role: 'developer', content: 'KEEP INSTRUCTIONS' },
    { type: 'message', role: 'user', content: SECRET_TEXT },
    { type: 'message', role: 'assistant', content: 'EARLIER ANSWER' }, trigger], ...extra });
const usageLimit = (seconds = 3600) => Response.json({ error: { type: 'usage_limit_reached', code: 'usage_limit_reached',
  message: "You've hit your usage limit.", resets_at: Math.floor(Date.now() / 1000) + seconds } }, { status: 429 });
const reply = text => Response.json({ id: 'resp_test', status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] });
const nativeCompaction = () => Response.json({ id: 'resp_native', status: 'completed',
  output: [{ type: 'compaction', encrypted_content: 'native-openai-compaction' }] });
const isSummary = body => body.instructions?.startsWith('Produce only');

async function fixture(t, { openai = () => usageLimit(), ...options } = {}) {
  const calls = [], metrics = [];
  const server = createRouter({ catalog, codexRoot: options.codexRoot ?? home(t), authenticate: () => true,
    bridgeKey: () => 'internal-key', summaryModel: 'gpt-test', allowTestOrigins: true, historyMode: 'selected',
    nativeBase: 'http://127.0.0.1:9998/v1', bridgeBase: 'http://127.0.0.1:9997/v1',
    onMetric: metric => metrics.push(metric),
    fetcher: async (url, init) => {
      const body = JSON.parse(init.body);
      const provider = url.includes(':9998') ? 'openai' : 'opencode';
      calls.push({ provider, url, headers: init.headers, body });
      if (provider === 'openai') return openai(body, url);
      return reply(isSummary(body) ? 'SELECTED SUMMARY' : 'ANSWER');
    }, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const send = (body, path = '/v1/responses', token = 'owner-native-token') => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const health = () => fetch(`http://127.0.0.1:${server.address().port}/health`).then(response => response.json());
  return { calls, metrics, send, health };
}
function home(t) {
  const root = mkdtempSync(join(tmpdir(), 'selected-compaction-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
function events(text) {
  return text.split(/\n\n/).map(frame => frame.split('\n').find(line => line.startsWith('data:')))
    .filter(Boolean).map(line => JSON.parse(line.slice(5)));
}
function compactionItems(text) {
  const done = events(text).filter(event => event.type === 'response.output_item.done').map(event => event.item);
  return done.filter(item => item.type === 'compaction');
}

test('AC-01/AC-06: OpenAI 429 makes the selected model write one router-owned compaction item', async t => {
  const f = await fixture(t);
  const response = await f.send(compactionRequest());
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const text = await response.text();
  const items = compactionItems(text);
  assert.equal(items.length, 1);
  assert.ok(items[0].encrypted_content.startsWith(SELECTED_COMPACTION_PREFIX));
  const completed = events(text).find(event => event.type === 'response.completed');
  assert.equal(completed.response.output.filter(item => item.type === 'compaction').length, 1);
  assert.match(text, new RegExp(SELECTED_COMPACTION_NOTICE.slice(0, 20)));
  assert.deepEqual(f.calls.map(call => call.provider), ['openai', 'opencode']);
  const summary = f.calls[1];
  assert.ok(isSummary(summary.body));
  assert.equal(summary.body.model, 'deepseek-test');
  assert.equal(summary.headers.authorization, undefined, 'OpenAI credentials never reach the selected provider');
  assert.ok(!JSON.stringify(summary.body).includes('compaction_trigger'));
  assert.match(JSON.stringify(summary.body), new RegExp(SECRET_TEXT));
  const metric = f.metrics.at(-1);
  assert.equal(metric.remote_compaction_fallback, 'selected');
  assert.equal(metric.remote_compaction_openai_status, 429);
  assert.equal(metric.remote_compaction_openai_reset_known, true);
  assert.equal(metric.remote_compaction_provider, 'opencode');
  assert.equal(metric.status, 200);
  assert.equal(metric.outcome, 'complete');
  const logged = JSON.stringify(f.metrics);
  for (const forbidden of [SECRET_TEXT, 'SELECTED SUMMARY', 'owner-native-token', 'internal-key', SELECTED_COMPACTION_PREFIX]) {
    assert.ok(!logged.includes(forbidden), `metric must not contain ${forbidden}`);
  }
});

test('AC-02: the next request unwraps the item for the selected model and for OpenAI', async t => {
  const f = await fixture(t, { openai: body => body.input.some(item => item.type === 'compaction_trigger') ? usageLimit() : reply('GPT') });
  const text = await (await f.send(compactionRequest())).text();
  const [item] = compactionItems(text);
  const history = [{ type: 'message', role: 'user', content: 'RETAINED USER MESSAGE' }, item,
    { type: 'message', role: 'user', content: 'NEXT TURN' }];
  for (const model of ['opencode/deepseek-test', 'gpt-test']) {
    const before = f.calls.length;
    const response = await f.send({ model, prompt_cache_key: thread, stream: false, input: history });
    assert.equal(response.status, 200, await response.text());
    const sent = f.calls.slice(before);
    assert.equal(sent.length, 1, 'no extra summary request is needed');
    const wire = JSON.stringify(sent[0].body);
    assert.equal(sent[0].provider, model === 'gpt-test' ? 'openai' : 'opencode');
    assert.ok(!wire.includes(SELECTED_COMPACTION_PREFIX), 'router wrapper never leaves the router');
    assert.ok(!wire.includes('"compaction"'), 'no compaction item is forwarded');
    assert.match(wire, /SELECTED SUMMARY/);
    assert.match(wire, /NEXT TURN/);
    assert.equal(f.metrics.at(-1).selected_compaction_restored, 1);
  }
});

test('AC-02: a later compaction sends the unwrapped summary to OpenAI, not the wrapper', async t => {
  const f = await fixture(t, { openai: () => nativeCompaction() });
  const item = encodeSelectedCompaction('EARLIER SELECTED SUMMARY');
  const response = await f.send(compactionRequest({ input: [item, { type: 'message', role: 'user', content: 'more' }, trigger] }));
  assert.equal(response.status, 200); await response.text();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].provider, 'openai');
  const wire = JSON.stringify(f.calls[0].body);
  assert.ok(!wire.includes(SELECTED_COMPACTION_PREFIX));
  assert.match(wire, /EARLIER SELECTED SUMMARY/);
});

test('AC-02: a damaged router item stops before any upstream request', async t => {
  const f = await fixture(t);
  const response = await f.send({ model: 'opencode/deepseek-test', input: [
    { type: 'compaction', encrypted_content: SELECTED_COMPACTION_PREFIX + 'not-json' }, { role: 'user', content: 'hi' }] });
  assert.equal(response.status, 422);
  assert.match(await response.text(), /selected_compaction_invalid/);
  assert.equal(f.calls.length, 0);
});

test('AC-03: when OpenAI succeeds, Luna still writes the compaction and the selected model is not asked', async t => {
  const f = await fixture(t, { openai: () => nativeCompaction() });
  const response = await f.send(compactionRequest());
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /native-openai-compaction/);
  assert.ok(!text.includes(SELECTED_COMPACTION_PREFIX));
  assert.deepEqual(f.calls.map(call => call.provider), ['openai']);
  assert.equal(f.calls[0].body.model, 'gpt-test');
  assert.equal(f.metrics.at(-1).remote_compaction_fallback, 'openai');
});

test('AC-04: OpenAI is skipped until its reset time, then asked again', async t => {
  let clock = Date.now();
  const f = await fixture(t, { summaryLimitWindow: new SummaryLimitWindow(() => clock) });
  for (const expected of [['openai', 'opencode'], ['opencode']]) {
    const before = f.calls.length;
    const response = await f.send(compactionRequest({ input: [{ role: 'user', content: 'turn ' + before }, trigger] }));
    assert.equal(response.status, 200); assert.equal(compactionItems(await response.text()).length, 1);
    assert.deepEqual(f.calls.slice(before).map(call => call.provider), expected);
  }
  assert.equal(f.metrics.at(-1).remote_compaction_openai_skipped, true);
  clock += 2 * 3600 * 1000;
  const before = f.calls.length;
  await (await f.send(compactionRequest({ input: [{ role: 'user', content: 'after reset' }, trigger] }))).text();
  assert.equal(f.calls[before].provider, 'openai', 'Luna is used again after the reset time');
});

test('#188: /health shows only the latest OpenAI summary reset time for the menu bar app', async t => {
  let clock = Date.now();
  const f = await fixture(t, { summaryLimitWindow: new SummaryLimitWindow(() => clock) });
  assert.equal((await f.health()).summary_limit_until, null);
  await (await f.send(compactionRequest())).text();
  const until = (await f.health()).summary_limit_until;
  assert.ok(Number.isSafeInteger(until) && until > clock, 'the reset time is shown while limited');
  clock = until + 1;
  assert.equal((await f.health()).summary_limit_until, null, 'cleared after the reset time');
  const window = new SummaryLimitWindow(() => 1000);
  window.record('a', 5000); window.record('b', 9000);
  assert.equal(window.latestUntil(), 9000);
});

test('AC-04: an unknown reset time uses the short default window', async t => {
  let clock = Date.now();
  const f = await fixture(t, { summaryLimitWindow: new SummaryLimitWindow(() => clock), providerFallbackCooldownMs: 60000,
    openai: () => Response.json({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }, { status: 429 }) });
  await (await f.send(compactionRequest())).text();
  assert.equal(f.metrics.at(-1).remote_compaction_fallback, 'selected');
  assert.equal(f.metrics.at(-1).remote_compaction_openai_reset_known, false);
  let before = f.calls.length;
  await (await f.send(compactionRequest({ input: [{ role: 'user', content: 'soon' }, trigger] }))).text();
  assert.deepEqual(f.calls.slice(before).map(call => call.provider), ['opencode']);
  clock += 61000;
  before = f.calls.length;
  await (await f.send(compactionRequest({ input: [{ role: 'user', content: 'later' }, trigger] }))).text();
  assert.equal(f.calls[before].provider, 'openai');
});

test('AC-05: openai mode also falls back; ask mode stops before sending; GPT selections are unchanged', async t => {
  const openaiMode = await fixture(t, { historyMode: 'openai' });
  const response = await openaiMode.send(compactionRequest());
  assert.equal(response.status, 200); assert.equal(compactionItems(await response.text()).length, 1);
  assert.deepEqual(openaiMode.calls.map(call => call.provider), ['openai', 'opencode']);
  assert.equal(openaiMode.metrics.at(-1).remote_compaction_fallback, 'selected');

  const ask = await fixture(t, { historyMode: 'ask' });
  const stopped = await ask.send(compactionRequest());
  assert.equal(stopped.status, 422); assert.match(await stopped.text(), /history_mode_requires_plaintext/);
  assert.equal(ask.calls.length, 0);

  const gpt = await fixture(t);
  const limited = await gpt.send(compactionRequest({ model: 'gpt-test' }));
  assert.equal(limited.status, 429, 'a GPT selection keeps the OpenAI limit error');
  await limited.text();
  assert.deepEqual(gpt.calls.map(call => call.provider), ['openai']);
  assert.notEqual(gpt.metrics.at(-1).remote_compaction_fallback, 'selected');
});

test('legacy /responses/compact returns one router-owned item as JSON', async t => {
  const f = await fixture(t);
  const response = await f.send({ model: 'opencode/deepseek-test', prompt_cache_key: thread,
    input: [{ role: 'user', content: 'remember' }] }, '/v1/responses/compact');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.output.length, 1);
  assert.equal(body.output[0].type, 'compaction');
  assert.ok(body.output[0].encrypted_content.startsWith(SELECTED_COMPACTION_PREFIX));
  assert.deepEqual(f.calls.map(call => call.provider), ['openai', 'opencode']);
  assert.match(f.calls[0].url, /\/responses\/compact$/);
});

test('an earlier OpenAI compaction is rebuilt from the owner log before the selected model summarizes', async t => {
  const root = home(t);
  const directory = join(root, 'sessions', '2026', '11', '12');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const opaque = { type: 'compaction', encrypted_content: 'opaque-history' };
  writeFileSync(join(directory, `rollout-date-${thread}.jsonl`), [
    { type: 'session_meta', payload: { id: thread } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: 'ORIGINAL REQUIREMENT' } },
    { type: 'compacted', payload: { replacement_history: [opaque] } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n', { mode: 0o600 });
  const f = await fixture(t, { codexRoot: root });
  const response = await f.send(compactionRequest({ input: [opaque, { role: 'user', content: 'after' }, trigger] }));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(compactionItems(await response.text()).length, 1);
  const summary = f.calls.find(call => call.provider === 'opencode');
  const wire = JSON.stringify(summary.body);
  assert.match(wire, /ORIGINAL REQUIREMENT/);
  assert.ok(!wire.includes('opaque-history'));
  assert.equal(f.metrics.at(-1).history_source, 'owner_rollout');
});

test('the selected summary failing is reported without fabricating a compaction', async t => {
  const f = await fixture(t, { fetcher: async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.includes(':9998')) return usageLimit();
    return isSummary(body) ? Response.json({ error: { code: 'invalid_request_error' } }, { status: 400 }) : reply('ANSWER');
  } });
  const response = await f.send(compactionRequest());
  assert.ok(response.status >= 400);
  const text = await response.text();
  assert.match(text, /compaction_handoff_failed/);
  assert.ok(!text.includes(SELECTED_COMPACTION_PREFIX));
});

test('automatic DeepSeek summaries move to the next same-model provider on a limit', async t => {
  const model = 'opencode/deepseek-v4.1-flash';
  const autoCatalog = { models: [
    { slug: model, router_provider: 'opencode', router_model: 'deepseek-v4.1-flash', context_window: 1000000 },
    { slug: 'gpt-6.1-sol', router_provider: 'openai' },
  ] };
  const calls = [], metrics = [];
  const server = createRouter({ historyMode: 'selected', catalog: autoCatalog, authenticate: () => true, manualProvidersEnabled: true,
    codexRoot: home(t), bridgeKey: () => 'bridge-only', manualKey: p => p + '-only', providerFallbackState: new ProviderFallbackState(),
    summaryLimitWindow: new SummaryLimitWindow(), onMetric: m => metrics.push(m), fetcher: async (url, init) => {
      const provider = Object.entries(MANUAL_PROVIDERS).find(([, c]) => url.startsWith(c.base))?.[0]
        ?? (url.includes('127.0.0.1:8788') ? 'opencode' : 'openai');
      calls.push(provider);
      if (provider === 'openai' || provider === 'opencode') return usageLimit();
      const chunk = value => `data: ${JSON.stringify(value)}\n\n`;
      return new Response(chunk({ id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: 'CHAIN SUMMARY' }, finish_reason: null }] })
        + chunk({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, { method: 'POST',
    headers: { authorization: 'Bearer native-secret', 'content-type': 'application/json' },
    body: JSON.stringify(compactionRequest({ model })) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(compactionItems(await response.text()).length, 1);
  assert.equal(calls[0], 'openai');
  assert.ok(calls.includes('opencode') && calls.at(-1) !== 'opencode', calls.join());
  assert.deepEqual(metrics.at(-1).remote_compaction_limited_providers, ['opencode']);
  assert.notEqual(metrics.at(-1).remote_compaction_provider, 'opencode');
});

test('codec round-trips and rejects empty or oversized summaries', () => {
  const item = encodeSelectedCompaction('要約テキスト');
  const restored = restoreSelectedCompactions([item]);
  assert.equal(restored.count, 1);
  assert.match(restored.input[0].content[0].text, /要約テキスト/);
  assert.equal(restoreSelectedCompactions([{ type: 'compaction', encrypted_content: 'native' }]), null);
  assert.throws(() => encodeSelectedCompaction(' '));
  assert.throws(() => encodeSelectedCompaction('x'.repeat(70000)));
  const json = selectedCompactionResponse(item, { compactEndpoint: true });
  assert.equal(JSON.parse(json.body).output[0].encrypted_content, item.encrypted_content);
});

test('a 429 during the OpenAI pre-summary of a large compaction also falls back to the selected model', async t => {
  const f = await fixture(t, { summaryInputLimitTokens: 40000 });
  const big = Array.from({ length: 12 }, (_, index) => ({ type: 'message', role: index % 2 ? 'assistant' : 'user',
    content: `part ${index} ` + 'context '.repeat(4000) }));
  const response = await f.send(compactionRequest({ input: [...big, { type: 'message', role: 'user', content: 'latest' }, trigger] }));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(compactionItems(await response.text()).length, 1);
  const openai = f.calls.filter(call => call.provider === 'openai');
  assert.ok(openai.length >= 1 && openai.every(call => isSummary(call.body)), 'only the OpenAI pre-summary was attempted');
  assert.ok(f.calls.some(call => call.provider === 'opencode' && isSummary(call.body)));
  assert.equal(f.metrics.at(-1).remote_compaction_fallback, 'selected');
  assert.equal(f.metrics.at(-1).remote_compaction_openai_status, 429);
});

// ---- Review fixes for PR #187 ----

test('review 1 (AC-02): native tool endpoints unwrap the router item; nested items stop before sending', async t => {
  const f = await fixture(t, { openai: () => Response.json({ ok: true }) });
  const item = encodeSelectedCompaction('SEARCH CONTEXT SUMMARY');
  for (const path of ['/v1/alpha/search', '/v1/images/generations']) {
    const before = f.calls.length;
    const response = await f.send({ model: 'gpt-test', input: [item, { role: 'user', content: 'find it' }] }, path);
    assert.equal(response.status, 200, await response.text());
    const sent = f.calls.slice(before);
    assert.equal(sent.length, 1);
    const wire = JSON.stringify(sent[0].body);
    assert.ok(!wire.includes(SELECTED_COMPACTION_PREFIX), path + ' must not forward the wrapper');
    assert.match(wire, /SEARCH CONTEXT SUMMARY/);
  }
  for (const [path, body] of [
    ['/v1/alpha/search', { model: 'gpt-test', query: { history: [item] } }],
    ['/v1/responses', { model: 'opencode/deepseek-test', input: [{ role: 'user', content: [item] }] }],
    ['/v1/responses', { model: 'gpt-test', input: [{ role: 'user', content: 'hi' }], metadata: { carried: item } }],
  ]) {
    const before = f.calls.length;
    const response = await f.send(body, path);
    assert.equal(response.status, 422);
    assert.match(await response.text(), /selected_compaction_unsupported_location/);
    assert.equal(f.calls.length, before, 'no upstream request');
  }
  assert.equal(containsSelectedCompaction({ a: [{ b: item }] }), true);
  assert.equal(containsSelectedCompaction({ type: 'compaction', encrypted_content: 'native' }), false);
  // Deeper than the walk limit must still be caught, never forwarded.
  let deep = item;
  for (let index = 0; index < 66; index++) deep = { next: deep };
  assert.equal(containsSelectedCompaction(deep), true);
  let plainDeep = { text: 'hello' };
  for (let index = 0; index < 66; index++) plainDeep = { next: plainDeep };
  assert.equal(containsSelectedCompaction(plainDeep), false);
  const before = f.calls.length;
  const response = await f.send({ model: 'gpt-test', query: deep }, '/v1/alpha/search');
  assert.equal(response.status, 422);
  assert.match(await response.text(), /selected_compaction_unsupported_location/);
  assert.equal(f.calls.length, before, 'deep marker: no upstream request');
  // Absurd nesting (with or without a marker) is a clear 4xx, never a 502 or a forward.
  for (const leaf of [item, { text: 'hello' }]) {
    // Built as raw text: JSON.stringify itself cannot serialize this depth.
    const huge = '{"model":"gpt-test","query":' + '{"next":'.repeat(8000) + JSON.stringify(leaf) + '}'.repeat(8000) + '}';
    const count = f.calls.length;
    const tooDeep = await f.send(huge, '/v1/alpha/search');
    assert.equal(tooDeep.status, 422);
    assert.match(await tooDeep.text(), /request_too_deep/);
    assert.equal(f.calls.length, count, 'too deep: no upstream request');
  }
});

test('review 2 (AC-04): a pre-summary 429 keeps the reset time from the response, not only the default', async t => {
  let clock = Date.now();
  const f = await fixture(t, { summaryInputLimitTokens: 40000, providerFallbackCooldownMs: 60000,
    summaryLimitWindow: new SummaryLimitWindow(() => clock), openai: () => usageLimit(2 * 3600) });
  const big = Array.from({ length: 12 }, (_, index) => ({ type: 'message', role: index % 2 ? 'assistant' : 'user',
    content: `part ${index} ` + 'context '.repeat(4000) }));
  const response = await f.send(compactionRequest({ input: [...big, { type: 'message', role: 'user', content: 'latest' }, trigger] }));
  assert.equal(response.status, 200); await response.text();
  assert.equal(f.metrics.at(-1).remote_compaction_openai_reset_known, true);
  clock += 10 * 60 * 1000; // past the 1-minute default, before the 2-hour reset
  let before = f.calls.length;
  await (await f.send(compactionRequest({ input: [{ role: 'user', content: 'small' }, trigger] }))).text();
  assert.deepEqual(f.calls.slice(before).map(call => call.provider), ['opencode'], 'OpenAI stays skipped until resets_at');
  clock += 2 * 3600 * 1000;
  before = f.calls.length;
  await (await f.send(compactionRequest({ input: [{ role: 'user', content: 'after' }, trigger] }))).text();
  assert.equal(f.calls[before].provider, 'openai');
});

test('review 3 (AC-04): the limit window is kept per OpenAI account', async t => {
  const f = await fixture(t, { openai: (body, url) => usageLimit() });
  await (await f.send(compactionRequest(), '/v1/responses', 'account-a')).text();
  let before = f.calls.length;
  await (await f.send(compactionRequest({ input: [{ role: 'user', content: 'a again' }, trigger] }), '/v1/responses', 'account-a')).text();
  assert.deepEqual(f.calls.slice(before).map(call => call.provider), ['opencode'], 'account A is skipped');
  before = f.calls.length;
  await (await f.send(compactionRequest({ input: [{ role: 'user', content: 'b first' }, trigger] }), '/v1/responses', 'account-b')).text();
  assert.equal(f.calls[before].provider, 'openai', 'account B still tries OpenAI');
  assert.equal(f.calls[before].headers.authorization, 'Bearer account-b');
  const window = new SummaryLimitWindow(() => 1000, 2);
  window.record('a', 5000); window.record('b', 5000); window.record('c', 5000);
  assert.equal(window.blocked('a'), false, 'oldest entry is evicted at the cap');
  assert.equal(window.blocked('c'), true);
});

test('review 4: every provider at its limit answers 429 with retry-after, not 502', async t => {
  const f = await fixture(t, { fetcher: async (url, init) => {
    JSON.parse(init.body);
    return usageLimit(1800);
  } });
  const response = await f.send(compactionRequest());
  assert.equal(response.status, 429);
  const retry = Number(response.headers.get('retry-after'));
  assert.ok(retry > 1700 && retry <= 1800, String(retry));
  const body = await response.json();
  assert.equal(body.error.type, 'summary_provider_limits_exhausted');
  assert.match(body.error.message, /どちらも利用上限/);
  assert.deepEqual(f.metrics.at(-1).remote_compaction_limited_providers, ['opencode']);
});

test('review 5: a router item inside a compaction request reaches the selected model as text, without log restore', async t => {
  const f = await fixture(t);
  const item = encodeSelectedCompaction('PREVIOUS SELECTED SUMMARY');
  const response = await f.send(compactionRequest({ input: [item, { role: 'user', content: 'more work' }, trigger] }));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(compactionItems(await response.text()).length, 1);
  const summary = f.calls.find(call => call.provider === 'opencode');
  const wire = JSON.stringify(summary.body);
  assert.match(wire, /PREVIOUS SELECTED SUMMARY/);
  assert.ok(!wire.includes(SELECTED_COMPACTION_PREFIX));
  assert.equal(f.metrics.at(-1).history_source, undefined, 'the owner log is not needed');
  assert.equal(f.metrics.at(-1).selected_compaction_restored, 1);
});
