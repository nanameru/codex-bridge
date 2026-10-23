import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createRouter } from '../src/model-router.mjs';
import { toolRecoveryPlan, answerOnlyStream } from '../src/tool-recovery.mjs';
function history(count, result = ()=>'BUILD_OK', name = ()=>'exec', args = ()=>'{}') {
  return [{role:'user',content:'check and answer'},...Array.from({length:count},(_,i)=>[
    {type:'function_call',call_id:'call_'+i,name:name(i),arguments:args(i)},
    {type:'function_call_output',call_id:'call_'+i,output:result(i)},
  ]).flat()];
}

test('repeated completed results recover, while deliberate polling and changing results can exceed six calls',()=>{
  assert.equal(toolRecoveryPlan(history(2)),null);
  assert.equal(toolRecoveryPlan(history(3)).reason,'repeated_completed_result');
  for(const output of ['{"status":"pending"}','Process running with session ID 1','PENDING']) assert.equal(toolRecoveryPlan(history(8,()=>output)),null);
  assert.equal(toolRecoveryPlan(history(8,i=>'progress '+i)),null);
  assert.equal(toolRecoveryPlan(history(8,()=> 'same',()=> 'write_stdin')),null);
});

test('changing tools/arguments and waiting loops have a finite turn budget, new users reset it',()=>{
  const input=history(64,i=>'result '+i,i=>'tool_'+i,i=>JSON.stringify({i}));
  assert.equal(toolRecoveryPlan(input).reason,'turn_tool_budget');
  assert.equal(toolRecoveryPlan(history(64,()=> 'pending',()=> 'wait')).reason,'turn_tool_budget');
  assert.equal(toolRecoveryPlan([...input,{role:'user',content:'continue'}]),null);
  assert.equal(toolRecoveryPlan(history(4).slice(0,-1)),null);
  assert.equal(toolRecoveryPlan(history(4).slice(1)),null);
});

test('parallel calls count as one round and a normal operation is never rewritten',()=>{
  const input=[{role:'user',content:'parallel'},...Array.from({length:8},(_,i)=>({type:'function_call',name:'exec',call_id:'c'+i,arguments:'{}'})),
    ...Array.from({length:8},(_,i)=>({type:'function_call_output',call_id:'c'+i,output:'OK'}))];
  assert.equal(toolRecoveryPlan(input),null);
});

test('router requests a single tool-free answer preserving results and native requests',async context=>{
  const calls=[];
  const router=createRouter({authenticate:()=>true,bridgeKey:()=> 'test',catalog:{models:[{slug:'opencode/test',router_provider:'opencode'},{slug:'gpt-test',router_provider:'openai'}]},
    fetcher:async (_url,options)=>{calls.push(JSON.parse(options.body));return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'BUILD_OK'}]}]});}});
  router.listen(0,'127.0.0.1');await once(router,'listening');
  context.after(async()=>{router.closeAllConnections();await new Promise(r=>router.close(r));});
  const input=history(3),original=structuredClone(input);
  const send=model=>fetch(`http://127.0.0.1:${router.address().port}/v1/responses`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test'},body:JSON.stringify({model,input})});
  const recovered=await send('opencode/test');assert.equal(recovered.status,200);assert.match(await recovered.text(),/BUILD_OK/);
  assert.equal(calls[0].tool_choice,'none');assert.deepEqual(calls[0].tools,[]);assert.deepEqual(calls[0].input.slice(0,-1),original);
  assert.equal(calls[0].input.at(-1).role,'developer');assert.deepEqual(input,original);
  await (await send('gpt-test')).text();assert.equal(calls[1].tool_choice,undefined);
});

test('provider ignoring tool_choice cannot dispatch tools during recovery',async()=>{
  for(const type of ['application/json','text/event-stream']){
    const payload={type:'response.completed',response:{status:'completed',output:[{type:'function_call',name:'unsafe',call_id:'new'}]}};
    const text=type==='application/json'?JSON.stringify(payload.response):`event: response.completed\ndata: ${JSON.stringify(payload)}\n\n`;
    const chunks=[];for await(const chunk of Readable.from([Buffer.from(text)]).pipe(answerOnlyStream(type,4096)))chunks.push(chunk);
    const result=Buffer.concat(chunks).toString();assert.match(result,/invalid_prompt/);assert.doesNotMatch(result,/unsafe|function_call/);
  }
});
