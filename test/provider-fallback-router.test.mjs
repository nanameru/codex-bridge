import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createRouter } from '../src/model-router.mjs';
import { ProviderFallbackState } from '../src/provider-fallback.mjs';
import { MANUAL_PROVIDERS } from '../src/manual-providers.mjs';

const model = 'opencode/deepseek-v4.1-flash';
const catalog = { models: [
  { slug: model, router_provider: 'opencode', router_model: 'deepseek-v4.1-flash', context_window: 1000000 },
  { slug: 'gpt-6.1-sol', router_provider: 'openai' },
] };
const quota = (window = 'short', seconds = 60, status = 429) => Response.json({ error: {
  code: 'usage_exceeded', window, resets_at: new Date(Date.now() + seconds * 1000).toISOString(),
} }, { status });
const answer = provider => provider === 'opencode' || provider === 'openai'
  ? Response.json({ id: 'resp_ok', status: 'completed', output: [{ type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: provider }] }] })
  : Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: provider }, finish_reason: 'stop' }] });
async function fixture(t, handler = p => answer(p), options = {}) {
  let clock = Date.now();
  const calls = [], metrics = [];
  const state = new ProviderFallbackState({ now: () => clock });
  const server = createRouter({ historyMode: "openai", catalog, authenticate: () => true, manualProvidersEnabled: true,
    bridgeKey: () => 'bridge-only', manualKey: p => p + '-only', providerFallbackState: state,
    onMetric: m => metrics.push(m), fetcher: async (url, init) => {
      const provider = Object.entries(MANUAL_PROVIDERS).find(([, c]) => url.startsWith(c.base))?.[0]
        ?? (url.includes('127.0.0.1:8788') ? 'opencode' : 'openai');
      calls.push({ provider, url, ...init, body: JSON.parse(init.body) });
      return handler(provider, calls.at(-1));
    }, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const send = (extra = {}) => fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
    method: 'POST', headers: { authorization: 'Bearer native-secret', 'chatgpt-account-id': 'private-account', 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: [{ role: 'user', content: 'latest' }], ...extra }),
  });
  return { send, calls, state, metrics, advance: ms => { clock += ms; } };
}

test('OpenCode→Command Code→Ollamaへ切替し、次の要求でOpenCodeへ直接復帰する', async t => {
  let limited = true;
  const f = await fixture(t, p => limited && p !== 'ollama' ? quota(p === 'opencode' ? 'monthly' : 'weekly') : answer(p));
  assert.equal((await f.send()).status, 200);
  assert.deepEqual(f.calls.map(c => c.provider), ['opencode', 'commandcode', 'ollama']);
  await (await f.send()).text();
  assert.deepEqual(f.calls.map(c => c.provider), ['opencode', 'commandcode', 'ollama', 'ollama']);
  limited = false; f.advance(61000);
  await (await f.send()).text();
  assert.equal(f.calls.at(-1).provider, 'opencode');
  for (const c of f.calls.filter(c => c.provider !== 'opencode')) {
    assert.equal(c.headers.authorization, 'Bearer ' + c.provider + '-only');
    assert.equal(c.headers['chatgpt-account-id'], undefined);
    assert.equal(c.headers['x-codex-bridge-auth'], undefined);
    assert.ok(!JSON.stringify(c).includes('native-secret'));
    assert.equal(c.body.messages.at(-1).content, 'latest');
  }
});

test('上位の短期・週次枠解除で復帰し月間枠が残る間は復帰しない', async t => {
  const f = await fixture(t);
  const block = (provider, window, ms) => f.state.recordLimit(provider, { providerLimited: true, window,
    resetAt: f.state.now() + ms, status: 429, resetKnown: true });
  block('opencode', 'short', 1000); block('opencode', 'monthly', 3000);
  block('commandcode', 'weekly', 2000);
  await (await f.send()).text(); assert.equal(f.calls.at(-1).provider, 'ollama');
  f.advance(1500);
  await (await f.send()).text(); assert.equal(f.calls.at(-1).provider, 'ollama');
  f.advance(600);
  await (await f.send()).text(); assert.equal(f.calls.at(-1).provider, 'commandcode');
  f.advance(1000);
  await (await f.send()).text(); assert.equal(f.calls.at(-1).provider, 'opencode');
});

test('全社上限を記録し再送せず、未知の解除時刻はクールダウン後だけ再試行する', async t => {
  const f = await fixture(t, () => Response.json({ error: 'no credits' }, { status: 402 }), { providerFallbackCooldownMs: 1000 });
  assert.equal((await f.send()).status, 402);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.state.candidates(), []);
  const blocked = await f.send();
  assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  assert.equal(f.calls.length, 3);
  f.advance(1100);
  assert.equal((await f.send()).status, 402); assert.equal(f.calls.length, 6);
});

test('単独で残ったOllamaの402も記録する', async t => {
  const f = await fixture(t, () => quota('monthly', 60, 402));
  for (const p of ['opencode', 'commandcode']) f.state.recordLimit(p, { providerLimited: true, window: 'monthly', resetAt: f.state.now() + 100000 });
  assert.equal((await f.send()).status, 402);
  assert.deepEqual(f.state.candidates(), []); assert.equal(f.calls.length, 1);
});

for (const status of [400, 401, 403, 500]) test(`${status}の通常エラーは他社へ再送しない`, async t => {
  const f = await fixture(t, () => Response.json({ error: { code: 'rate_limit_exceeded', message: 'Too many requests' } }, { status }));
  assert.equal((await f.send()).status, status); assert.equal(f.calls.length, 1);
  assert.equal(f.state.available('opencode'), true);
});

test('一時429はCommand Codeへ退避しRetry-After後の要求でOpenCodeへ戻る', async t => {
  let busy=true;
  const f=await fixture(t,p=>busy&&p==='opencode'
    ? Response.json({error:{code:'rate_limit_exceeded',message:'Too many requests'}},{status:429,headers:{'retry-after':'45'}})
    : answer(p));
  const r=await f.send();assert.equal(r.status,200);await r.text();
  assert.deepEqual(f.calls.map(c=>c.provider),['opencode','commandcode']);
  assert.equal(f.state.available('opencode'),false);
  assert.deepEqual(f.state.snapshot('opencode').windows,{});
  busy=false;f.advance(44000);
  await (await f.send()).text();assert.equal(f.calls.at(-1).provider,'commandcode');
  f.advance(1100);
  await (await f.send()).text();assert.equal(f.calls.at(-1).provider,'opencode');
});

test('ローカル暴走ガード429では他社へ逃げず保護を維持する', async t => {
  const f=await fixture(t,()=>Response.json({error:{type:'rate_limit_exceeded',message:'codex-bridge: このスレッドで1分間に40回を超えました。'}},{status:429}));
  const r=await f.send();assert.equal(r.status,429);await r.text();
  assert.equal(f.calls.length,1);assert.equal(f.state.available('opencode'),true);
});

test('次候補がない429は最後の応答本文を消費して呼出元へ返す', async t => {
  const f=await fixture(t,()=>Response.json({error:{code:'rate_limit_exceeded',message:'Too many requests'}},{status:429}),
    {manualKey:()=>null});
  const r=await f.send();assert.equal(r.status,429);
  assert.deepEqual(await r.json(),{error:{code:'rate_limit_exceeded',message:'Too many requests'}});
  assert.equal(f.calls.length,1);
});

test('一時429でもモデル表示を同期し全社制限時は各社1回で停止する', async t => {
  const selected=[];
  const f=await fixture(t,p=>p!=='ollama'?Response.json({error:{type:'server_error',message:'Upstream request failed: Endpoint is unavailable.'}},{status:429}):answer(p),{
    cliModelSyncEnabled:true,cliModelSync:{prepare:async()=>({automatic:true}),sync:async(_c,target)=>{selected.push(target);return 'updated';},close(){}},
  });
  await (await f.send()).text();
  assert.deepEqual(f.calls.map(c=>c.provider),['opencode','commandcode','ollama']);
  assert.deepEqual(selected,['opencode/deepseek-v4.1-flash','auto-commandcode/deepseek-v4.1-flash','auto-ollama/deepseek-v4.1-flash']);
  const blocked=await fixture(t,()=>Response.json({error:{message:'Too many requests'}},{status:429}));
  await (await blocked.send()).text();assert.equal(blocked.calls.length,3);
  const again=await blocked.send();assert.equal(again.status,429);await again.text();
  assert.equal(again.headers.get('retry-after'),'30');assert.equal(blocked.calls.length,3);
  blocked.advance(30001);await (await blocked.send()).text();assert.equal(blocked.calls.length,6);
});

test('ネットワーク障害は再送せず、手動指定と無効化設定を維持する', async t => {
  const broken = await fixture(t, () => { throw new Error('network'); });
  assert.equal((await broken.send()).status, 502); assert.equal(broken.calls.length, 1);
  const f = await fixture(t, () => quota());
  assert.equal((await f.send({ model: 'commandcode/deepseek-v4.1-flash' })).status, 429);
  assert.equal(f.calls.length, 1); assert.equal(f.state.available('commandcode'), true);
  const off = await fixture(t, () => quota(), { autoProviderFallback: false });
  assert.equal((await off.send()).status, 429); assert.equal(off.calls.length, 1);
});

test('成功SSE開始後の失敗イベントは他社へ再送しない', async t => {
  const f = await fixture(t, () => new Response('data: {"type":"response.failed","response":{"status":"failed","error":{"code":"usage_exceeded"}}}\n\n',
    { headers: { 'content-type': 'text/event-stream' } }));
  const r = await f.send({ stream: true }); await r.text();
  assert.equal(f.calls.length, 1); assert.equal(f.state.available('opencode'), true);
});

test('native remote compactionは全社上限中でも経路を変えない', async t => {
  const f = await fixture(t);
  for (const p of ['opencode','commandcode','ollama']) f.state.recordLimit(p, { providerLimited: true, resetAt: f.state.now() + 60000 });
  await (await f.send({ input: [{ type: 'compaction_trigger' }] })).text();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].provider, 'openai');
});

test('履歴準備の進捗SSE後も切替し、圧縮済み履歴と未完了ツールを維持する', async t => {
  const f = await fixture(t, async p => {
    if (p === 'openai') {
      await new Promise(resolve => setTimeout(resolve, 20));
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'handoff' }] }] });
    }
    if (p === 'opencode') return quota();
    return new Response('data: '+JSON.stringify({ choices: [{ index: 0, delta: { content: 'commandcode' }, finish_reason: 'stop' }] })+'\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }, { opencodeSoftLimitTokens: 1000, opencodeHardLimitTokens: 10000, handoffStatusDelayMs: 1 });
  const r = await f.send({ stream: true, tools: [{ type: 'custom', name: 'apply_patch' }], input: [
    { role: 'developer', content: 'keep constraints' }, { role: 'user', content: 'x'.repeat(40000) },
    { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'latest' },
    { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch', input: 'patch' },
    { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'done' },
  ] });
  const result = await r.text();
  assert.equal(r.status, 200); assert.match(result, /commandcode/); assert.match(result, /response.completed/);
  assert.deepEqual(f.calls.map(c => c.provider), ['openai','opencode','commandcode']);
  const chat = f.calls.at(-1).body;
  assert.ok(!JSON.stringify(chat).includes('x'.repeat(40000)));
  assert.ok(chat.messages.some(m => m.content === 'latest'));
  assert.equal(chat.messages.find(m => m.role === 'tool').content, 'done');
});

test('本文のない402も切替対象にする', async t => {
  const f = await fixture(t, p => p === 'opencode' ? new Response(null, { status: 402 }) : answer(p));
  const r = await f.send();
  assert.equal(r.status, 200); assert.equal(r.headers.get('x-codex-bridge-provider'), 'commandcode');
  assert.deepEqual(f.calls.map(c => c.provider), ['opencode','commandcode']);
});

test('全社が空本文402でも状態を記録する', async t => {
  const f = await fixture(t, () => new Response(null, { status: 402 }));
  assert.equal((await f.send()).status, 402);
  assert.equal(f.calls.length, 3); assert.deepEqual(f.state.candidates(), []);
});

test('前候補の小さいcontextを次候補の入力上限へ引き継がない', async t => {
  const { manualModels } = await import('../src/manual-providers.mjs');
  const f = await fixture(t, p => p === 'ollama' ? answer(p) : quota(), {
    manualProvidersEnabled: false, autoProviderFallback: true, opencodeHardLimitTokens: 100000,
    catalog: { models: [...catalog.models, ...manualModels().map(m => ({ ...m,
      context_window: m.router_provider === 'commandcode' ? 4000 : 8000 }))] },
  });
  const r = await f.send({ max_output_tokens: 100 });
  assert.equal(r.status, 200); await r.text();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.map(c => c.provider), ['opencode','commandcode','ollama']);
  assert.equal(f.metrics.at(-1).effective_input_limit_tokens, 7500);
});

test('CLI同期で再選択したOpenCodeにも通常経路の制限を適用し直接APIを使わない', async t => {
  const selected=[];
  const f=await fixture(t,p=>p==='opencode'?quota():answer(p),{
    cliModelSyncEnabled:true,
    cliModelSync:{prepare:async()=>({automatic:true}),sync:async(_context,target)=>{selected.push(target);return 'updated';},close(){}},
    catalog:{models:catalog.models.map(m=>m.router_provider==='opencode'?{...m,router_transport:'responses'}:m)},
    openCodeKey:()=>{throw new Error('direct API credential must not be read');},
  });
  const response=await f.send({prompt_cache_key:'019a12ab-1234-7654-a123-123456789012'});
  assert.equal(response.status,200);await response.text();
  assert.deepEqual(f.calls.map(c=>c.provider),['opencode','commandcode']);
  assert.ok(f.calls[0].url.startsWith('http://127.0.0.1:8788/'));
  assert.deepEqual(selected,['opencode/deepseek-v4.1-flash','auto-commandcode/deepseek-v4.1-flash']);
});

test('全社制限中は3社の固定リンクを表示する', async t => {
  const f=await fixture(t);
  for(const p of ['opencode','commandcode','ollama'])f.state.recordLimit(p,{providerLimited:true,resetAt:f.state.now()+60000});
  const response=await f.send();const text=await response.text();
  assert.equal(response.status,429);
  for(const url of ['https://opencode.ai/console/go','https://commandcode.ai/billing','https://ollama.com/pricing'])assert.ok(text.includes(url));
  assert.equal(f.calls.length,0);
});

test('OpenCodeの認証エラーにも固定リンクを出し上流のURLを隠す', async t => {
  const f=await fixture(t,()=>Response.json({error:{message:'secret https://evil.invalid'}},{status:401}));
  const response=await f.send();const text=await response.text();
  assert.equal(response.status,401);assert.ok(text.includes('https://opencode.ai/console/'));
  assert.ok(!text.includes('evil.invalid'));assert.ok(!text.includes('secret'));assert.equal(f.calls.length,1);
});

test('自動用Command Code/Ollamaの選択IDでもチェーンを維持し上位へ復帰する',async t=>{
  const f=await fixture(t,p=>p==='commandcode'?quota():answer(p));
  f.state.recordLimit('opencode',{providerLimited:true,window:'monthly',resetAt:f.state.now()+60000});
  await (await f.send({model:'auto-commandcode/deepseek-v4.1-flash'})).text();
  assert.deepEqual(f.calls.map(c=>c.provider),['commandcode','ollama']);
  f.advance(61000);
  await (await f.send({model:'auto-ollama/deepseek-v4.1-flash'})).text();
  assert.equal(f.calls.at(-1).provider,'opencode');
});
