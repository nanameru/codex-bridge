import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { directRecoveryHelp, providerHelp, providerNoticeStream, PROVIDER_HELP } from '../src/provider-help.mjs';
import { routedBody } from '../src/model-router.mjs';
import { fetchManualProvider, MANUAL_PROVIDERS } from '../src/manual-providers.mjs';
const transform=async(type,body)=>{
  const stream=Readable.from([body]).pipe(providerNoticeStream(type,100000,[providerHelp('opencode')]));
  let text='';for await(const chunk of stream)text+=chunk;return text;
};
test('各社の固定ログイン/支払いリンクを返し不明providerをリンク化しない',()=>{
  for(const [p,h]of Object.entries(PROVIDER_HELP)){assert.ok(providerHelp(p).includes(h.login));assert.ok(providerHelp(p).includes(h.billing));}
  assert.equal(providerHelp('https://evil.invalid'), '');assert.equal(providerHelp('__proto__'),'');
});
test('中継・提供元障害だけGPTのdirect退避方法を返す',()=>{
  const command='codex --profile direct';
  assert.ok(directRecoveryHelp(502,'upstream_error').includes(command));
  assert.ok(directRecoveryHelp(401,'authentication_required').includes(command));
  assert.ok(directRecoveryHelp(429,'provider_limits_exhausted').includes(command));
  assert.ok(directRecoveryHelp(503,'anything').includes(command));
  assert.equal(directRecoveryHelp(400,'invalid_json'),'');
  assert.equal(directRecoveryHelp(413,'request_too_large'),'');
});
test('未課金/認証エラーへ固定リンクを出し上流URLやキーは出さない',async()=>{
  for(const status of [401,402,403]){
    const response=await fetchManualProvider('commandcode',MANUAL_PROVIDERS.commandcode.base+'/responses',{
      body:JSON.stringify({model:MANUAL_PROVIDERS.commandcode.model,input:'hello'}),headers:{authorization:'Bearer private-key'},
    },async()=>Response.json({error:{message:'private-key https://evil.invalid'}},{status}),100000);
    const text=await response.text();
    assert.ok(text.includes(PROVIDER_HELP.commandcode.login));assert.ok(text.includes(PROVIDER_HELP.commandcode.billing));
    assert.ok(!text.includes('evil.invalid'));assert.ok(!text.includes('private-key'));
  }
});
test('継続できた場合の案内をJSONへ添え、次のモデル送信から除く',async()=>{
  const result=JSON.parse(await transform('application/json',JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'answer'}]}]})));
  assert.equal(result.output.length,2);assert.equal(result.output[0].phase,'commentary');
  const next=routedBody({input:result.output},{provider:'opencode',model:'deepseek-v4.1-flash'},100000);
  assert.equal(next.input.length,1);assert.ok(!JSON.stringify(next).includes('opencode.ai/console'));
});
test('SSEの案内はtoolのindex/call_idを維持しterminal outputにも残す',async()=>{
  const item={id:'fc_test',type:'function_call',name:'read',call_id:'call_test',arguments:'{}'};
  const frames=[{type:'response.created',response:{id:'resp_test',output:[]}},
    {type:'response.output_item.done',output_index:0,item},
    {type:'response.completed',response:{id:'resp_test',status:'completed',output:[item]}}];
  const output=await transform('text/event-stream',frames.map(x=>'data: '+JSON.stringify(x)+'\n\n').join(''));
  const events=output.split('\n').filter(l=>l.startsWith('data:')).map(l=>JSON.parse(l.slice(5)));
  const tool=events.find(e=>e.item?.id==='fc_test');assert.equal(tool.output_index,1);assert.equal(tool.item.call_id,'call_test');
  assert.equal(events.at(-1).response.output.length,2);
});
