import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createRouter } from '../src/model-router.mjs';
import { CHAT_PROVIDERS } from '../src/manual-providers.mjs';
import { ProviderFallbackState } from '../src/provider-fallback.mjs';
const go='opencode/deepseek-v4.1-flash', wt='auto-whatstoken/deepseek-v4.1-flash';
const answer=p=>p==='opencode'?Response.json({status:'completed',output:[]}):Response.json({choices:[{index:0,message:{role:'assistant',content:p},finish_reason:'stop'}]});
async function fixture(t,{enabled=true,key=true,eligible=true,handler=answer,gate,keys={}}={}) {
  const calls=[],metrics=[];let checks=0;
  const state=new ProviderFallbackState();
  const policy=gate??{check:async()=>{checks++;return{allowed:eligible,end:Date.now()+3600000,reason:'outside_free_window'};},unavailable(){}};
  const server=createRouter({catalog:{models:[{slug:go,router_provider:'opencode',router_model:'deepseek-v4.1-flash',context_window:1000000}]},
    authenticate:()=>true,manualProvidersEnabled:true,whatstokenFreeEnabled:enabled,whatstokenFreeGate:policy,
    providerFallbackState:state,bridgeKey:()=> 'local-bridge-only',manualKey:p=>p==='whatstoken'&&!key?null:keys[p]??p+'-key',
    onMetric:m=>metrics.push(m),fetcher:async(url,options)=>{
      const provider=Object.entries(CHAT_PROVIDERS).find(([,c])=>url.startsWith(c.base))?.[0]??'opencode';
      calls.push({provider,url,...options,body:JSON.parse(options.body)});return handler(provider,calls.at(-1));
    }});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  const send=async(extra={})=>{
    const r=await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`,{method:'POST',headers:{authorization:'Bearer native-secret','chatgpt-account-id':'private-account','content-type':'application/json'},body:JSON.stringify({model:go,input:[{role:'user',content:'synthetic only'}],...extra})});
    return{status:r.status,body:await r.text(),retryAfter:r.headers.get('retry-after')};
  };
  return{send,calls,metrics,state,checks:()=>checks};
}

test('明示有効化と無料確認時だけWhatsToken通常モデルを専用の鍵で使う',async t=>{
  const f=await fixture(t);assert.equal((await f.send({reasoning:{effort:'medium'}})).status,200);
  assert.deepEqual(f.calls.map(c=>c.provider),['whatstoken']);
  const c=f.calls[0];assert.equal(c.url,'https://www.whatstoken.ai/v1/chat/completions');
  assert.equal(c.body.model,'deepseek-v4.1-flash-1017');assert.equal(c.headers.authorization,'Bearer whatstoken-key');
  assert.equal(c.body.reasoning_effort,'high');assert.equal(c.body.thinking.type,'enabled');
  assert.equal(c.headers['chatgpt-account-id'],undefined);assert.equal(c.headers['x-codex-bridge-auth'],undefined);
  assert.doesNotMatch(JSON.stringify(c),/native-secret|private-account|local-bridge-only/);
});

test('無料時間外・キーなし・未有効化ではWhatsTokenへ送信しない',async t=>{
  for(const options of [{eligible:false},{key:false},{enabled:false}]) {
    const f=await fixture(t,options);assert.equal((await f.send()).status,200);
    assert.deepEqual(f.calls.map(c=>c.provider),['opencode']);
    if(options.key===false||options.enabled===false)assert.equal(f.checks(),0);
  }
});

test('WhatsTokenの自動選択IDから時間外もOpenCodeへ復帰する',async t=>{
  const f=await fixture(t,{eligible:false});assert.equal((await f.send({model:wt})).status,200);
  assert.deepEqual(f.calls.map(c=>c.provider),['opencode']);
});

test('機能を無効にしても残った自動WhatsToken選択IDからOpenCodeへ復帰する',async t=>{
  const f=await fixture(t,{enabled:false});assert.equal((await f.send({model:wt})).status,200);
  assert.deepEqual(f.calls.map(c=>c.provider),['opencode']);assert.equal(f.checks(),0);
});

test('選択後に無料条件が変われば実送信せずOpenCodeへ戻る',async t=>{
  let checks=0;
  const f=await fixture(t,{gate:{check:async()=>({allowed:++checks===1,end:Date.now()+3600000}),unavailable(){}}});
  assert.equal((await f.send()).status,200);assert.deepEqual(f.calls.map(c=>c.provider),['opencode']);
});

test('WhatsTokenの認証・残高・短期制限・5xx・通信失敗で既存ルートへ戻す',async t=>{
  for(const status of [401,402,403,429,500,'network']) {
    const f=await fixture(t,{handler:p=>{
      if(p!=='whatstoken')return answer(p);
      if(status==='network')throw new Error('secret exception');
      return Response.json({error:{code:'private-code',message:'secret exception'}},{status});
    }});
    const r=await f.send();assert.equal(r.status,200);
    assert.deepEqual(f.calls.map(c=>c.provider),['whatstoken','opencode']);
    assert.doesNotMatch(r.body,/secret exception|whatstoken-key/);
    assert.equal(f.calls[1].headers.authorization,undefined);
    assert.equal(f.calls[1].headers['x-codex-bridge-auth'],'local-bridge-only');
  }
});

test('WhatsToken→OpenCode→Command Code→Ollamaの既存利用枠追跡を維持する',async t=>{
  const f=await fixture(t,{handler:p=>p==='ollama'?answer(p):Response.json({error:{code:'insufficient_quota'}},{status:402})});
  assert.equal((await f.send()).status,200);
  assert.deepEqual(f.calls.map(c=>c.provider),['whatstoken','opencode','commandcode','ollama']);
});

test('本人の手動指定は無料時間中もWhatsTokenへ切り替えない',async t=>{
  const f=await fixture(t);assert.equal((await f.send({model:'commandcode/deepseek-v4.1-flash'})).status,200);
  assert.equal(f.checks(),0);assert.deepEqual(f.calls.map(c=>c.provider),['commandcode']);
});

test('WhatsTokenでもcustom toolの確定イベントと結果履歴を保持する',async t=>{
  const f=await fixture(t,{handler:()=>new Response('data: '+JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_patch',function:{name:'apply_patch',arguments:'{"input":"patch"}'}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})});
  const r=await f.send({stream:true,tools:[{type:'custom',name:'apply_patch',format:{type:'text'}}]});
  assert.equal(r.status,200);assert.match(r.body,/response.completed/);assert.match(r.body,/custom_tool_call/);
  assert.equal(f.calls[0].body.tools[0].function.name,'apply_patch');assert.equal(f.calls.length,1);
});

test('WhatsTokenの送信本文だけから登録済みのAPIキーを伏せ、ローカル履歴を変えない',async t=>{
  const escaped=String.raw`synthetic-escaped\"key`;
  const f=await fixture(t,{keys:{commandcode:escaped}});
  const input=[{role:'user',content:'The previous key was '+escaped+' and native-secret; keep the task.'}];
  const before=structuredClone(input);
  assert.equal((await f.send({input})).status,200);
  const sent=JSON.stringify(f.calls[0].body);
  assert.doesNotMatch(sent,/synthetic-escaped|native-secret/);assert.match(sent,/credential redacted/);
  assert.deepEqual(input,before);assert.equal(f.calls[0].headers.authorization,'Bearer whatstoken-key');
});

test('無料判定の注入clockと送信前の残時間判定に同じ時刻を使う',async t=>{
  const clock=Date.parse('2026-01-01T22:30:00+08:00');
  const f=await fixture(t,{gate:{now:()=>clock,check:async()=>({allowed:true,end:clock+3600000}),unavailable(){}}});
  assert.equal((await f.send()).status,200);assert.deepEqual(f.calls.map(c=>c.provider),['whatstoken']);
});

test('全社制限時の再開時刻に無料WhatsTokenの既知の解除も含める',async t=>{
  const f=await fixture(t);
  for(const provider of ['whatstoken','opencode','commandcode','ollama'])
    f.state.recordLimit(provider,{providerLimited:true,window:'short',resetAt:Date.now()+(provider==='whatstoken'?60000:600000),status:429,resetKnown:true});
  const r=await f.send();assert.equal(r.status,429);assert.ok(Number(r.retryAfter)<=60);assert.equal(f.calls.length,0);
});
