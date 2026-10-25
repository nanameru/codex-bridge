import assert from 'node:assert/strict';
import test from 'node:test';
import { CliModelSync, CLI_AUTO_MODEL, cliThreadId } from '../src/cli-model-sync.mjs';
const id='019a12ab-1234-7654-a123-123456789012';
const cc='auto-commandcode/deepseek-v4.1-flash', ollama='auto-ollama/deepseek-v4.1-flash';
function fixture() {
  let model=CLI_AUTO_MODEL, broken=false; const writes=[];
  const control={async request(method,params){
    if(broken)throw new Error('unavailable');
    if(method==='thread/read')return {thread:{id:params.threadId,modelProvider:'openai',model,status:{type:'active'}}};
    if(method==='thread/settings/update'){writes.push(params);model=params.model;return {};}
    throw new Error('unexpected');
  }};
  const sync=new CliModelSync({root:'/not-used',control});
  return {sync,control,writes,setModel:value=>{model=value;},break:()=>{broken=true;}};
}
test('自動の選択IDを更新し、再接続しても自動モードが維持される',async()=>{
  const f=fixture();const context=await f.sync.prepare(id,CLI_AUTO_MODEL);
  assert.equal(await f.sync.sync(context,cc),'updated');assert.equal(context.model,cc);
  const restored=new CliModelSync({root:'/not-used',control:f.control});
  const next=await restored.prepare(id,cc);assert.equal(next.automatic,true);
  assert.equal(await restored.sync(next,ollama),'updated');
});
test('手動指定のIDへ自動モードを拡張しない',async()=>{
  const f=fixture();f.setModel('commandcode/deepseek-v4.1-flash');
  assert.equal(await f.sync.prepare(id,'commandcode/deepseek-v4.1-flash'),null);
  assert.equal(await f.sync.prepare(id,CLI_AUTO_MODEL),null);assert.equal(f.writes.length,0);
});
test('通信中に本人が手動モデルへ変更した場合は上書きしない',async()=>{
  const f=fixture();const context=await f.sync.prepare(id,CLI_AUTO_MODEL);f.setModel('ollama/deepseek-v4.1-flash');
  assert.equal(await f.sync.sync(context,cc),'manual');assert.equal(f.writes.length,0);
});
test('手動モデルを行き来しても自動用IDとは混同しない',async()=>{
  const f=fixture();const context=await f.sync.prepare(id,CLI_AUTO_MODEL);await f.sync.sync(context,cc);
  f.setModel('ollama/deepseek-v4.1-flash');f.setModel('commandcode/deepseek-v4.1-flash');
  assert.equal(await f.sync.prepare(id,'commandcode/deepseek-v4.1-flash'),null);
  assert.equal(await f.sync.sync(context,ollama),'manual');
});
test('daemon停止中は表示同期を失敗させ、登録状態や会話を編集しない',async()=>{
  const f=fixture();const context=await f.sync.prepare(id,CLI_AUTO_MODEL);f.break();
  assert.equal(await f.sync.sync(context,ollama),'unavailable');assert.equal(await f.sync.prepare(id,cc),null);
  assert.equal(f.writes.length,0);
});
test('UUID以外のcache keyをthread操作へ使わない',()=>{
  assert.equal(cliThreadId({prompt_cache_key:'secret-or-text'}),null);
  assert.equal(cliThreadId({client_metadata:{thread_id:id}}),id);
  assert.equal(cliThreadId({}, {session_id:id}),id);
});

test('自動用2項目は提供元を明示し手動用の固定IDと区別できる',async()=>{
  const {withManualModels}=await import('../src/manual-providers.mjs');
  const {catalogRoutes}=await import('../src/model-router.mjs');
  const catalog=withManualModels({models:[{slug:CLI_AUTO_MODEL,router_provider:'opencode',router_model:'deepseek-v4.1-flash'}]});
  const routes=catalogRoutes(catalog);
  for(const provider of ['commandcode','ollama']){
    const auto=catalog.models.find(m=>m.slug==='auto-'+provider+'/deepseek-v4.1-flash');
    assert.ok(auto.display_name.endsWith('（自動切替）'));assert.equal(auto.router_provider,provider);
    assert.equal(routes.get(auto.slug).autoFallback,true);
    assert.equal(routes.get(provider+'/deepseek-v4.1-flash').autoFallback,undefined);
  }
  assert.deepEqual(withManualModels(catalog),catalog);
});

test('確認RPCが停止しても表示同期の確認期限で終了する',{timeout:2500},async()=>{
  let updating=false;
  const control={async request(method,params){
    if(method==='thread/settings/update'){updating=true;return {};}
    if(updating)return new Promise(()=>{});
    return {thread:{id:params.threadId,modelProvider:'openai',model:CLI_AUTO_MODEL,status:{type:'active'}}};
  }};
  const sync=new CliModelSync({root:'/not-used',control});const context=await sync.prepare(id,CLI_AUTO_MODEL);
  const start=performance.now();assert.equal(await sync.sync(context,cc),'unavailable');
  assert.ok(performance.now()-start<1800);
});
test('設定更新が非同期でも確認後に選択モデルを確定する',async()=>{
  let model=CLI_AUTO_MODEL,writes=0;
  const control={async request(method,params){
    if(method==='thread/settings/update'){writes++;setTimeout(()=>{model=params.model;},25);return {};}
    return {thread:{id:params.threadId,modelProvider:'openai',model,status:{type:'active'}}};
  }};
  const sync=new CliModelSync({root:'/not-used',control});const context=await sync.prepare(id,CLI_AUTO_MODEL);
  assert.equal(await sync.sync(context,cc),'updated');assert.equal(context.model,cc);assert.equal(writes,1);
});
