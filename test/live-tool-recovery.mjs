// Explicit, bounded live check. Uses synthetic tool data; never executes tools.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readPrivateFile, codexRoot } from '../src/local-security.mjs';
if (process.env.RUN_LIVE_MODELS !== '1') { console.log('Skipped: RUN_LIVE_MODELS=1 is required.'); process.exit(0); }
const auth=JSON.parse(readPrivateFile(codexRoot(),'auth.json'));
const token=auth.tokens?.access_token??auth.OPENAI_API_KEY;
assert.ok(token,'owner auth unavailable');
let requests=0;
const tool={type:'function',name:'route_probe',description:'Read the synthetic build status once.',parameters:{type:'object',properties:{},additionalProperties:false}};
const user={role:'user',content:'ビルド状況を一度確認して結果を日本語で教えて。'};
async function ask(model,input,thread) {
 assert.ok(++requests<=4,'live request budget exceeded');
 const res=await fetch('http://127.0.0.1:8791/v1/responses',{method:'POST',redirect:'error',signal:AbortSignal.timeout(60000),
  headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({model,input,tools:[tool],stream:true,max_output_tokens:1024,
    reasoning:{effort:'low'},prompt_cache_key:thread,instructions:'You are a coding agent. Call route_probe once then answer using its completed result. Never call it again after a completed build status.'})});
 assert.equal(res.status,200,'live upstream HTTP failure');
 const text=await res.text();assert.ok(Buffer.byteLength(text)<512000,'live response too large');
 const frames=text.split(/\r?\n\r?\n/).map(frame=>frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n')).filter(v=>v&&v!=='[DONE]').map(JSON.parse);
 const final=frames.findLast(frame=>['response.completed','response.failed'].includes(frame.type))?.response;
 assert.equal(final?.status,'completed',final?.error?.code??'missing terminal');
 return final.output;
}
const thread='bridge-regression-'+randomUUID();
const first=await ask('opencode/glm-5.3-flash',[user],thread);
const calls=first.filter(i=>i.type==='function_call');assert.equal(calls.length,1);assert.equal(calls[0].name,'route_probe');
const second=await ask('opencode/glm-5.3-flash',[user,...first,{type:'function_call_output',call_id:calls[0].call_id,output:'{"status":"done","result":"BUILD_OK_42"}'}],thread);
assert.ok(second.some(i=>i.type==='message'&&i.content?.some(p=>p.text?.includes('BUILD_OK_42'))));assert.ok(!second.some(i=>i.type==='function_call'));
console.log(JSON.stringify({model:'glm-5.3-flash',scenario:'tool_once_then_answer',passed:true,requests:2}));
for(const model of ['opencode/glm-5.3-flash','opencode/hy4-preview']) {
 const input=[user,...Array.from({length:3},(_,i)=>[{type:'function_call',call_id:'c'+i,name:'route_probe',arguments:'{}'},
  {type:'function_call_output',call_id:'c'+i,output:'{"status":"done","result":"BUILD_OK_42"}'}]).flat()];
 const output=await ask(model,input,'bridge-regression-'+randomUUID());
 assert.ok(!output.some(i=>['function_call','custom_tool_call'].includes(i.type)));
 assert.ok(output.some(i=>i.type==='message'&&i.content?.some(p=>p.text?.includes('BUILD_OK_42'))));
 console.log(JSON.stringify({model,scenario:'repeated_completed_results_to_answer',passed:true,requests:1}));
}
