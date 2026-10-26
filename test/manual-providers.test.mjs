import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync,writeFileSync,chmodSync,symlinkSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRouter } from '../src/model-router.mjs';
import { MANUAL_PROVIDERS, manualModels, manualChatBody, readManualKey, fetchManualProvider } from '../src/manual-providers.mjs';
const catalog = { models: [{ slug: 'gpt-test', router_provider: 'openai' },
  { slug: 'opencode/deepseek-test', router_provider: 'opencode', router_model: 'deepseek-test' }] };
const answer = () => Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] });
async function fixture(t, extra = {}) {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, ...options, body: JSON.parse(options.body) }); return answer(); };
  const server = createRouter({ catalog, manualProvidersEnabled: true, authenticate: () => true,
    manualKey: p => p + '-key', bridgeKey: () => 'bridge-key', fetcher, ...extra });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { calls, base, send: body => fetch(base + '/v1/responses', { method:'POST',
    headers: { authorization:'Bearer native-secret', 'chatgpt-account-id':'private-account', 'content-type':'application/json' }, body:JSON.stringify(body) }) };
}

test('DeepSeekの手動宛先と認証を分離し同名OpenCodeと共存する', async t => {
  const { calls, send, base } = await fixture(t);
  const models = await (await fetch(base + '/v1/models')).json();
  assert.equal(models.data.length,7);
  for (const provider of ['commandcode','ollama']) {
    const body = { model: provider + '/deepseek-v4.1-flash', input: [{ role:'user',content:'latest' }],
      tools:[{ type:'function',name:'read',parameters:{type:'object'} }], reasoning:{effort:'high'} };
    const response = await send(body);
    assert.equal(response.status,200, await response.clone().text());
    const parsed = await response.json(); assert.equal(parsed.status,'completed');
    const sent = calls.at(-1);
    assert.equal(sent.url,MANUAL_PROVIDERS[provider].base + '/chat/completions');
    assert.equal(sent.headers.authorization, 'Bearer ' + provider + '-key');
    assert.equal(sent.headers['chatgpt-account-id'], undefined);
    assert.equal(sent.headers['x-codex-bridge-auth'], undefined);
    assert.equal(sent.body.model,MANUAL_PROVIDERS[provider].model);
    assert.equal(sent.body.tools[0].function.name,'read');
    assert.ok(!JSON.stringify(sent).includes('native-secret'));
    assert.ok(!JSON.stringify(sent).includes('private-account'));
  }
  assert.equal(calls.length,2);
});

test('APIキー未設定と429と認証拒否で別社へ自動切替しない', async t => {
  const missing = await fixture(t, { manualKey: () => null });
  const request = { model:'ollama/deepseek-v4.1-flash',input:'continue' };
  const response = await missing.send(request);
  assert.equal(response.status,503); assert.match(await response.text(),/provider_key_required/);
  assert.equal(missing.calls.length,0);
  for (const status of [401,403,429]) {
    let calls=0;
    const f = await fixture(t,{ fetcher: async (url, options) => {
      calls++; assert.equal(url,MANUAL_PROVIDERS.ollama.base + '/chat/completions');
      return Response.json({ error:{code:'rate_limit_exceeded',message:options.headers.authorization} },{status,headers:{'retry-after':'10'}});
    } });
    const r=await f.send(request); assert.equal(r.status,status);
    assert.ok(!(await r.text()).includes('ollama-key'));
    assert.equal(calls,1);
  }
});

test('Chat SSEの確定ツールだけをResponsesへ変換しcustom tool結果を維持する', async t => {
  const sent=[];
  const {send}=await fixture(t,{fetcher:async (_url,options)=>{
    sent.push(JSON.parse(options.body));
    const chunk={choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_patch',function:{name:'apply_patch',arguments:'{"input":"patch"}'}}]},finish_reason:'tool_calls'}]};
    return new Response('data: '+JSON.stringify(chunk)+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  const body={model:'commandcode/deepseek-v4.1-flash',stream:true, tools:[{type:'custom',name:'apply_patch',format:{type:'text'}}],
    input:[{role:'user',content:'edit'}]};
  const r=await send(body); const text=await r.text();
  assert.equal(r.status,200); assert.match(text,/response.completed/); assert.match(text,/custom_tool_call/);
  assert.match(text,/"input":"patch"/);
  assert.equal(sent[0].tools[0].function.name,'apply_patch');
});

test('不完全なstreamから実行可能toolを出さずredirectも拒否する', async t => {
  const partial={choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_bad',function:{name:'read',arguments:'{}'}}]}}]};
  const f=await fixture(t,{fetcher:async()=>new Response('data: '+JSON.stringify(partial)+'\n\n',{headers:{'content-type':'text/event-stream'}})});
  const r=await f.send({model:'ollama/deepseek-v4.1-flash',stream:true,input:'read'}); const text=await r.text();
  assert.match(text,/response.failed/); assert.doesNotMatch(text,/response.output_item.done/);
  const redirect=await fixture(t,{fetcher:async()=>new Response(null,{status:302,headers:{location:'https://evil.invalid'}})});
  const rr=await redirect.send({model:'commandcode/deepseek-v4.1-flash',input:'hello'});
  assert.equal(rr.status,502); assert.match(await rr.text(),/upstream_redirect/);
});

test('鍵はprivate fileまたは専用envだけから読みsymlinkや公開権限を拒否する', () => {
  const root=mkdtempSync(join(tmpdir(),'manual-keys-')); chmodSync(root,0o700);
  try {
    writeFileSync(join(root,'ollama-api-key'),'file-key',{mode:0o600});
    assert.equal(readManualKey('ollama',root,{}),'file-key');
    assert.equal(readManualKey('ollama',root,{OLLAMA_API_KEY:'env-key'}),'env-key');
    chmodSync(join(root,'ollama-api-key'),0o644); assert.equal(readManualKey('ollama',root,{}),null);
    symlinkSync(join(root,'ollama-api-key'),join(root,'commandcode-api-key')); assert.equal(readManualKey('commandcode',root,{}),null);
    assert.equal(readManualKey('ollama',root,{OLLAMA_API_KEY:'bad\nkey'}),null);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('reasoningの宛先別形式と手動カタログの固定IDを確認する', () => {
  assert.equal(manualModels().length,3);
  for(const [provider,config] of Object.entries(MANUAL_PROVIDERS)) {
    const chat=manualChatBody(provider,{model:config.model,input:[],reasoning:{effort:'high'}});
    assert.equal(chat.reasoning_effort,'high');
    assert.equal('temperature' in chat,false);
    assert.throws(()=>manualChatBody(provider,{model:'wrong',input:[]}),/invalid/);
  }
});

test('custom toolの結果をChatへ再送し古い履歴を予算内で要約する', async t => {
  const calls=[];
  const f=await fixture(t,{summaryModel:'gpt-test',opencodeSoftLimitTokens:1000,opencodeHardLimitTokens:10000,
    fetcher:async(url,options)=>{
      const body=JSON.parse(options.body);calls.push({url,body});
      if(body.instructions?.startsWith('Produce only'))return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'handoff'}]}]});
      return answer();
    }});
  const body={model:'ollama/deepseek-v4.1-flash',tools:[{type:'custom',name:'apply_patch'}],
    input:[{role:'developer',content:'keep constraints'},{role:'user',content:'x'.repeat(40000)},
      {role:'assistant',content:'old answer'},{role:'user',content:'latest'},
      {type:'custom_tool_call',call_id:'call_patch',name:'apply_patch',input:'patch'},
      {type:'custom_tool_call_output',call_id:'call_patch',output:'done'}]};
  const response=await f.send(body);assert.equal(response.status,200,await response.text());
  assert.equal(calls.length,2);
  assert.ok(calls[0].body.instructions.startsWith('Produce only'));
  const sent=calls[1].body;
  assert.equal(sent.messages.find(m=>m.role==='tool').content,'done');
  assert.equal(sent.messages.find(m=>m.tool_calls)?.tool_calls[0].function.arguments,'{"input":"patch"}');
  assert.ok(sent.messages.some(m=>m.content==='latest'));
  assert.ok(!JSON.stringify(sent).includes('x'.repeat(40000)));
});

test('動的カタログ更新でもDeepSeekとKimiの手動モデルが残る', async t => {
  const f=await fixture(t,{catalogProvider:{get:async()=>catalog}});
  const response=await fetch(f.base+'/codex/models?client_version=0.164.0',{headers:{authorization:'Bearer synthetic'}});
  const listed=await response.json();assert.equal(response.status,200);
  assert.equal(listed.models.length,7);
  assert.ok(listed.models.some(m=>m.slug==='commandcode/deepseek-v4.1-flash'));
  assert.ok(listed.models.some(m=>m.slug==='ollama/deepseek-v4.1-flash'));
  assert.ok(listed.models.every(m=>!m.router_provider));
});

test('手動接続にも会話単位の暴走ガードを適用し別会話を巻き込まない', async t => {
  const f=await fixture(t);
  const body={model:'ollama/deepseek-v4.1-flash',input:'hello',client_metadata:{thread_id:'a'}};
  for(let i=0;i<40;i++){const r=await f.send(body);assert.equal(r.status,200);await r.text();}
  const limited=await f.send(body);assert.equal(limited.status,429);assert.ok(limited.headers.has('retry-after'));await limited.text();
  const other=await f.send({...body,client_metadata:{thread_id:'b'}});assert.equal(other.status,200);await other.text();
  assert.equal(f.calls.length,41);
});

test('stream取消で上流readerを中止し実行可能toolを確定しない', async () => {
  let cancelled=false;
  const controller=new AbortController();
  const upstream=new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{index:0,delta:{content:'partial'}}]})+'\n\n'));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
  const response=await fetchManualProvider('ollama',MANUAL_PROVIDERS.ollama.base+'/responses',{
    signal:controller.signal,headers:{authorization:'Bearer synthetic'},body:JSON.stringify({model:MANUAL_PROVIDERS.ollama.model,input:'hello',stream:true})},async()=>upstream,1000000);
  const reader=response.body.getReader();await reader.read();controller.abort();
  await reader.cancel().catch(()=>{});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cancelled,true);
});

test('既存の入力予算無効化設定でも手動接続が常に413にならない', async t => {
  const f=await fixture(t,{opencodeHardLimitTokens:0,opencodeSoftLimitTokens:0});
  const response=await f.send({model:'ollama/deepseek-v4.1-flash',input:'hello'});
  assert.equal(response.status,200,await response.text());
  assert.equal(f.calls.length,1);
});

test('Kimi K3.1 Proを一覧から選び正式なCommand Code IDへ送り、ツールとusageを往復する', async t => {
  const sent=[];
  const slug='commandcode/moonshotai/Kimi-K3.1-Pro';
  const {send,base}=await fixture(t,{fetcher:async(url,options)=>{
    sent.push({url,...options,body:JSON.parse(options.body)});
    const tool=JSON.parse(options.body).messages.some(m=>m.role==='tool');
    const chunk={choices:[{index:0,delta:tool?{content:'KIMI_OK'}:{tool_calls:[{index:0,id:'kimi_call',function:{name:'read',arguments:'{}'}}]},finish_reason:tool?'stop':'tool_calls'}]};
    return new Response('data: '+JSON.stringify(chunk)+'\n\ndata: '+JSON.stringify({choices:[],usage:{prompt_tokens:20,completion_tokens:4}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  const listed=await(await fetch(base+'/v1/models')).json();
  assert.ok(listed.data.some(m=>m.id===slug));
  const tools=[{type:'function',name:'read',parameters:{type:'object'}}];
  const first=await(await send({model:slug,input:'read',tools,stream:true,reasoning:{effort:'medium'}})).text();
  assert.match(first,/response.completed/);assert.match(first,/"call_id":"kimi_call"/);
  const second=await(await send({model:slug,stream:true,tools,input:[{role:'user',content:'read'},{type:'function_call',call_id:'kimi_call',name:'read',arguments:'{}'},{type:'function_call_output',call_id:'kimi_call',output:'result'}]})).text();
  assert.match(second,/KIMI_OK/);assert.match(second,/"input_tokens":20/);
  for(const s of sent){assert.equal(s.url,MANUAL_PROVIDERS.commandcode.base+'/chat/completions');assert.equal(s.body.model,'moonshotai/Kimi-K3.1-Pro');assert.equal(s.headers.authorization,'Bearer commandcode-key');assert.equal(s.body.temperature,undefined);assert.equal(s.body.reasoning_effort,undefined);assert.ok(!JSON.stringify(s).includes('native-secret'));}
});
