import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { commonCatalog, publicCommonCatalog, commandModelEntries } from '../src/common-models.mjs';
import { createRouter } from '../src/model-router.mjs';
import { ProviderFallbackState } from '../src/provider-fallback.mjs';
import { createLiveCatalog } from '../src/live-catalog.mjs';

const go = id => ({ slug: 'opencode/' + id, display_name: 'OpenCode · ' + id,
  router_provider: 'opencode', router_model: id, context_window: 1000000, router_transport: 'chat' });
const native = { slug: 'gpt-native', router_provider: 'openai', display_name: 'GPT Native' };
const catalog = { models: [native, ...['deepseek-v4.1-flash', 'glm-5.3', 'kimi-k3', 'only-go', 'claude-haiku-5-5'].map(go)] };
const cmd = (id, endpoints = ['/chat/completions']) => ({ id, context_length: 128000, supported_endpoints: endpoints });

test('共通集合は名前空間と大小文字だけ正規化し、専用モデルと未対応APIと曖昧なモデルを除外', () => {
  const result = commonCatalog(catalog);
  assert.deepEqual(result.models.map(m => m.slug), ['gpt-native', 'shared/deepseek-v4.1-flash','shared/glm-5.3','shared/kimi-k3']);
  assert.doesNotMatch(JSON.stringify(result.models.map(({display_name,description})=>({display_name,description}))), /OpenCode|Command Code|Ollama/);
  assert.equal(result.models[0], native);
  assert.deepEqual(commonCatalog(catalog, []).models, [native]);
  assert.doesNotMatch(JSON.stringify(publicCommonCatalog(result)), /router_common_model|router_provider|router_transport|router_model/);
  assert.equal(result.models[3].router_common_model, 'moonshotai/Kimi-K3');
  const ambiguous = commonCatalog(catalog, [cmd('a/kimi-k3'),cmd('b/Kimi-K3')]);
  assert.deepEqual(ambiguous.models, [native]);
  const version = commonCatalog(catalog, [cmd('a/kimi-k3.1-pro'),cmd('a/claude-haiku-5-5',['/messages'])]);
  assert.deepEqual(version.models, [native]);
  assert.equal(commonCatalog(catalog,[cmd('z-ai/glm-5.3')]).models[1].context_window,128000);
  assert.throws(()=>commandModelEntries({data:[cmd('../escape\n')]}));
  assert.throws(()=>commandModelEntries({data:[cmd('a'),cmd('a')]}));
});

async function fixture(t, handler, extra = {}) {
  let now = Date.now(); const calls = [], sync = [], metrics = [];
  const state = new ProviderFallbackState({now:()=>now});
  const server = createRouter({catalog, commonModelsEnabled:true, manualProvidersEnabled:true,
    cliModelSyncEnabled:true, cliModelSync:{prepare(){sync.push('prepare');},sync(){sync.push('sync');}},
    historyMode:'openai', authenticate:()=>true, bridgeKey:()=> 'bridge-key', manualKey:p=>p+'-key',
    providerFallbackState:state, onMetric: metric => metrics.push(metric), fetcher:async(url,init)=>{
      const provider = url.includes('commandcode.ai') ? 'commandcode' : url.includes('127.0.0.1:8788') ? 'opencode' : 'other';
      const call = {provider,url,headers:init.headers,body:JSON.parse(init.body)}; calls.push(call);
      return handler(call);
    }, ...extra });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  const base = `http://127.0.0.1:${server.address().port}`;
  const send=(model='shared/glm-5.3',body={})=> fetch(base+'/v1/responses', {method:'POST',headers:{authorization:'Bearer native-secret','chatgpt-account-id':'native-account','content-type':'application/json'},body:JSON.stringify({model,input:[{role:'user',content:'keep-history'}],...body})});
  return {send,calls,state,sync,metrics,base,advance:ms=>{now+=ms;}};
}
const quota = () => Response.json({error:{code:'usage_exceeded',window:'short'}},{status:429,headers:{'retry-after':'60'}});
const ok = ({provider}) => provider==='commandcode'
  ? Response.json({choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}]})
  : Response.json({id:'ok',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}],status:'completed'});

test('各モデルは同一IDでのみ切替して復帰し、認証と履歴・toolsを維持、選択名の同期はしない',async t=>{
  for (const [id,target] of [['glm-5.3','zai-org/GLM-5.3'],['kimi-k3','moonshotai/Kimi-K3'],['deepseek-v4.1-flash','deepseek/deepseek-v4.1-flash']]) {
    let limited=true;
    const f=await fixture(t,c=>c.provider==='opencode'&&limited?quota():ok(c));
    const tools=[{type:'function',name:'read',parameters:{type:'object',properties:{}}}];
    const response=await f.send('shared/'+id,{tools});
    assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/利用枠|切り替え|Command Code|OpenCode/);
    assert.deepEqual(f.calls.map(c=>c.provider),['opencode','commandcode']);
    assert.equal(f.calls[0].body.model,id);assert.equal(f.calls[1].body.model,target);
    assert.equal(f.calls[1].headers.authorization,'Bearer commandcode-key');
    assert.equal(f.calls[1].headers['chatgpt-account-id'],undefined);
    assert.doesNotMatch(JSON.stringify(f.calls[1]),/native-secret|native-account|bridge-key/);
    assert.equal(f.calls[1].body.messages.at(-1).content,'keep-history');
    assert.equal(f.calls[1].body.tools[0].function.name,'read');
    assert.deepEqual(f.sync,[]);
    limited=false; f.advance(61000);await (await f.send('shared/'+id)).text();
    assert.equal(f.calls.at(-1).provider,'opencode');assert.equal(f.calls.at(-1).body.model,id);
  }
});

test('共通でない旧IDは拒否し共通旧IDは互換維持、両経路制限時に別モデル・他社へ切替しない',async t=>{
  const f=await fixture(t,()=>quota());
  assert.equal((await f.send('opencode/only-go')).status,400);
  assert.equal((await f.send('commandcode/moonshotai/Kimi-K3.1-Pro')).status,400);
  const r=await f.send('opencode/glm-5.3');assert.equal(r.status,429);await r.text();
  assert.deepEqual(f.calls.map(c=>c.provider),['opencode','commandcode']);
  const exhausted=await f.send('shared/glm-5.3');assert.equal(exhausted.status,429);await exhausted.text();
  assert.equal(f.calls.length,2);
  const models=await (await fetch(f.base+'/v1/models')).json();
  assert.deepEqual(models.data.map(m=>m.id),commonCatalog(catalog).models.map(m=>m.slug));
  assert.ok(models.data.filter(m=>m.id.startsWith('shared/')).every(m=>m.owned_by==='shared'));
});

test('ライブ共通一覧は追加・削除を反映し、Command Code取得失敗時は検証済み一覧を維持',async()=>{
  let clock=0, fail=false, ids=['glm-5.3'], commandIds=[cmd('zai-org/GLM-5.3')];const calls=[];
  const live=createLiveCatalog({initial:catalog,seed:[],key:()=> 'go-secret',commonModelsEnabled:true,
    now:()=>clock,ttlMs:100,retryMs:10,fetcher:async(url,options)=>{
      calls.push({url,options});
      if(url.includes('commandcode.ai')) {if(fail)throw Error('PRIVATE');return Response.json({data:commandIds});}
      if(url.includes('models.dev'))return Response.json({'opencode-go':{models:{}}});
      if(url.includes('opencode.ai'))return Response.json({data:ids.map(id=>({id}))});
      return Response.json({models:[native]});
    }});
  const get=()=>live.get({authorization:'Bearer native-secret'},'0.164.0');
  assert.deepEqual((await get()).models.map(m=>m.slug),['gpt-native','shared/glm-5.3']);
  clock=101;ids.push('kimi-k3');commandIds.push(cmd('moonshotai/Kimi-K3'));
  assert.equal((await get()).models.length,3);
  clock=202;fail=true;assert.equal((await get()).models.length,3);
  clock=303;fail=false;commandIds=[cmd('moonshotai/Kimi-K3')];
  assert.deepEqual((await get()).models.map(m=>m.slug),['gpt-native','shared/kimi-k3']);
  assert.ok(calls.filter(c=>c.url.includes('commandcode.ai')).every(c=>!c.options.headers.authorization));
});

test('ストリーミングでも同一モデルのまま切替し提供元通知を出さない',async t=>{
  const f=await fixture(t,c=>c.provider==='opencode'?quota():new Response(
    'data: '+JSON.stringify({id:'chat-test',choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]})+'\n\n'+
    'data: '+JSON.stringify({id:'chat-test',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',
    {headers:{'content-type':'text/event-stream'}}));
  const r=await f.send('shared/glm-5.3',{stream:true});const text=await r.text();
  assert.equal(r.status,200);assert.match(text,/response.completed/);assert.match(text,/OK/);
  assert.doesNotMatch(text,/Command Code|OpenCode|切り替え|利用枠/);
  assert.equal(f.calls.at(-1).body.model,'zai-org/GLM-5.3');assert.deepEqual(f.sync,[]);
});

test('既存の提供元無効化設定がある場合はCommand Codeへ自動送信しない',async t=>{
  const f=await fixture(t,()=>quota(),{manualProvidersEnabled:false});
  const r=await f.send();assert.equal(r.status,429);await r.text();
  assert.ok(f.calls.every(c=>c.provider==='opencode'));
});

test('DeepSeekだけ画像対応として公開し、異なる世代や未検証モデルは昇格しない',()=>{
  const models=publicCommonCatalog(commonCatalog(catalog)).models;
  const ds=models.find(m=>m.slug==='shared/deepseek-v4.1-flash');
  assert.deepEqual(ds.input_modalities,['text','image']);
  assert.equal(ds.supports_image_detail_original,true);
  assert.deepEqual(models.find(m=>m.slug==='shared/glm-5.3').input_modalities,['text']);
  const other=commonCatalog(catalog,[cmd('unverified/deepseek-v4.1-flash')]);
  assert.deepEqual(other.models[1].input_modalities,['text']);
});

test('ユーザー画像とview_imageの画像結果を同一DeepSeekの自動切替で保持する',async t=>{
  const url='data:image/png;base64,iVBORw0KGgo=';
  for(const toolResult of [false,true]){
    const f=await fixture(t,c=>c.provider==='opencode'?quota():ok(c));
    const image={type:'input_image',image_url:url,detail:'original'};
    const input=toolResult?[
      {role:'user',content:'Read the screenshot'},
      {type:'function_call',call_id:'view',name:'view_image',arguments:'{}'},
      {type:'function_call_output',call_id:'view',output:[image]},
    ]:[{role:'user',content:[{type:'input_text',text:'Read the screenshot'},image]}];
    const before=structuredClone(input);
    const r=await f.send('shared/deepseek-v4.1-flash',{input});
    assert.equal(r.status,200);await r.text();assert.deepEqual(input,before);
    assert.deepEqual(f.calls.map(c=>c.provider),['opencode','commandcode']);
    assert.equal(f.calls[1].body.model,'deepseek/deepseek-v4.1-flash');
    const messages=f.calls[1].body.messages;
    const images=messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='image_url');
    assert.equal(images.length,1);assert.equal(images[0].image_url.url,url);
    assert.equal(images[0].image_url.detail,'high');
  }
});

const summaryRequest = call => JSON.stringify(call.body).includes('Produce only a conversation handoff summary.');
const summaryAnswer = call => call.provider === 'opencode' ? ok(call) : new Response(
  'data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content:'PORTABLE SUMMARY'},finish_reason:null}]})+'\n\n'+
  'data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',
  {headers:{'content-type':'text/event-stream'}});
const restoreSummary = body => ({body:{...body,input:[{role:'user',content:'ORIGINAL FACT'},...body.input.slice(-1)]},prefixEnd:1});
const compactedInput = [{type:'compaction',encrypted_content:'PRIVATE OPAQUE'}, {role:'user',content:'LATEST REQUEST'}];

for (const limit of ['quota','transient']) test(`共通DeepSeekの要約中${limit}429を同一モデルで切り替え履歴を継続する`,async t=>{
  const f=await fixture(t,c=>c.provider==='opencode' ? (limit==='quota'?quota():Response.json(
    {error:{code:'rate_limit_exceeded'}},{status:429,headers:{'retry-after':'30'}})) : summaryRequest(c)?summaryAnswer(c):ok(c),
    {historyMode:'selected',restoreHistory:restoreSummary});
  const r=await f.send('shared/deepseek-v4.1-flash',{input:compactedInput});
  assert.equal(r.status,200);const text=await r.text();assert.match(text,/OK/);
  const summaries=f.calls.filter(summaryRequest);
  assert.deepEqual(summaries.map(c=>c.provider),['opencode','commandcode']);
  assert.deepEqual(f.calls.map(c=>c.provider),['opencode','commandcode','commandcode']);
  assert.equal(summaries[0].body.model,'deepseek-v4.1-flash');
  assert.equal(summaries[1].body.model,'deepseek/deepseek-v4.1-flash');
  assert.doesNotMatch(JSON.stringify(f.calls),/native-secret|native-account|PRIVATE OPAQUE/);
  assert.doesNotMatch(JSON.stringify(summaries[1]),/bridge-key/);
  assert.equal(summaries[1].headers.authorization,'Bearer commandcode-key');
  assert.match(JSON.stringify(summaries[1].body.messages),/ORIGINAL FACT/);
  assert.match(JSON.stringify(f.calls.at(-1).body),/LATEST REQUEST/);
  assert.equal(f.metrics.at(-1).summary_provider,'commandcode');
  assert.equal(f.metrics.at(-1).summary_model,'deepseek/deepseek-v4.1-flash');
  assert.equal(f.state.available('opencode'),false);
});

for(const stream of [false,true]) test(`要約の全候補制限は429で有限停止しGPT案内を出さない stream=${stream}`,async t=>{
  const f=await fixture(t,()=>quota(),{historyMode:'selected',restoreHistory:restoreSummary,handoffStatusDelayMs:0});
  const r=await f.send('shared/deepseek-v4.1-flash',{input:compactedInput,stream});
  const text=await r.text();
  if(stream && r.status===200){assert.match(text,/rate_limit_exceeded/);assert.match(text,/HTTP 429/);}
  else assert.equal(r.status,429);
  assert.doesNotMatch(text,/directプロファイル|codex --profile direct|HTTP 502/);
  assert.deepEqual(f.calls.map(c=>c.provider),['opencode','commandcode']);
  assert.equal(f.metrics.at(-1).summary_error_code,'summary_provider_limits_exhausted');
  const again=await f.send('shared/deepseek-v4.1-flash',{input:compactedInput});
  assert.equal(again.status,429);await again.text();assert.equal(f.calls.length,2);
});

for(const kind of ['local','auth','filter']) test(`要約の${kind}拒否は他社に再送しない`,async t=>{
  const f=await fixture(t,()=>Response.json({error:{code:kind==='filter'?'content_filter':'invalid_request_error',
    message:kind==='local'?'codex-bridge: thread guard':'PRIVATE ERROR'}},{status:kind==='local'?429:kind==='auth'?401:400}),
    {historyMode:'selected',restoreHistory:restoreSummary});
  const r=await f.send('shared/deepseek-v4.1-flash',{input:compactedInput});await r.text();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].provider,'opencode');
  assert.equal(f.state.available('opencode'),true);
});

test('途中chunkの成功を提供元切替後の再送でも再利用する',async t=>{
  let recovering=false, first=true;
  const f=await fixture(t,c=>{
    if(summaryRequest(c) && first){first=false;return summaryAnswer(c);}
    if(!recovering)return Response.json({error:{code:'rate_limit_exceeded'}},
      {status:429,headers:{'retry-after':c.provider==='opencode'?'120':'1'}});
    return summaryRequest(c)?summaryAnswer(c):ok(c);
  },{historyMode:'selected',summaryInputLimitTokens:24000,restoreHistory:body=>({body:{...body,
    input:[{role:'user',content:'FACT '.repeat(40000)},...body.input.slice(-1)]},prefixEnd:1})});
  const before=structuredClone(compactedInput);
  const session = {input:compactedInput,prompt_cache_key:'01a1777d-4508-72a1-9dbe-dcd799f721ab'};
  const fail=await f.send('shared/deepseek-v4.1-flash',session);
  assert.equal(fail.status,429);await fail.text();
  const initial=f.calls[0];assert.equal(f.calls.length,3);
  recovering=true;f.advance(2000);
  const start=f.calls.length;
  const success=await f.send('shared/deepseek-v4.1-flash',session);
  assert.equal(success.status,200);await success.text();
  assert.ok(f.calls.slice(start).every(c=>c.provider==='commandcode'));
  assert.equal(f.metrics.at(-1).summary_checkpoint_hits,1);
  assert.ok(!JSON.stringify(f.calls.slice(start)).includes(initial.body.input[0].content));
  assert.deepEqual(compactedInput,before);
});
