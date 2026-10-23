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

test('length recovery grows output once without executing tools or replaying the partial answer', async context => {
 for (const stream of [false,true]) {
  for (const mode of ['success','high-cap','length','tool','filter','explicit-cap']) {
   const calls=[],metrics=[];
   const failed=reason=>({id:'resp_cut',status:'failed',output:[],error:{code:'invalid_prompt',reason}});
   const wrap=payload=>stream?new Response(`event: response.${payload.status}\ndata: ${JSON.stringify({type:'response.'+payload.status,response:payload})}\n\n`,{headers:{'content-type':'text/event-stream'}}):Response.json(payload);
   const router=createRouter({authenticate:()=>true,bridgeKey:()=> 'test',catalog:{models:[{slug:'opencode/test',router_provider:'opencode'}]},onMetric:m=>metrics.push(m),
    fetcher:async (_url,options)=>{
     calls.push(JSON.parse(options.body));
     if(calls.length===1)return wrap(failed(mode==='filter'?'content_filter':'max_output_tokens'));
     if(mode==='length')return wrap(failed('max_output_tokens'));
     const output=mode==='tool'?[{type:'function_call',name:'unsafe',call_id:'danger',arguments:'{}'}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'RECOVERED'}]}];
     return wrap({id:'resp_ok',status:'completed',output});
    }});
   router.listen(0,'127.0.0.1');await once(router,'listening');
   try{
    const response=await fetch(`http://127.0.0.1:${router.address().port}/v1/responses`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test'},body:JSON.stringify({model:'opencode/test',tools:[{type:'function',name:'unsafe',parameters:{type:'object'}}],input:history(3),stream,...(mode==='explicit-cap'?{max_output_tokens:1024}:mode==='high-cap'?{max_output_tokens:32768}:{})})});
    const text=await response.text();
    const retry= !['filter','explicit-cap'].includes(mode);
    assert.equal(calls.length,retry?2:1);
    assert.equal(calls[0].max_output_tokens,mode==='explicit-cap'?1024:8192);
    for(const call of calls){assert.deepEqual(call.tools,[]);assert.equal(call.tool_choice,'none');}
    if(retry){assert.equal(calls[1].max_output_tokens,16384);assert.deepEqual(calls[1].input,calls[0].input);}
    if(['success','high-cap'].includes(mode))assert.match(text,/RECOVERED/);else assert.doesNotMatch(text,/RECOVERED/);
    assert.doesNotMatch(text,/unsafe|danger|function_call/);
    if(['success','high-cap'].includes(mode))assert.match(text,/completed/);else assert.match(text,/failed/);
    await new Promise(r=>setImmediate(r));
    assert.equal(metrics.at(-1).recovery_length_retries,retry?1:undefined);
   }finally{router.closeAllConnections();await new Promise(r=>router.close(r));}
  }
 }
});

test('cancelled length retry terminates without issuing another generation',async context=>{
 let count=0,retrySignal;
 let ready;const retryStarted=new Promise(r=>ready=r);
 const router=createRouter({authenticate:()=>true,bridgeKey:()=> 'test',catalog:{models:[{slug:'opencode/test',router_provider:'opencode'}]},
  fetcher:async(_url,options)=>{
   if(++count===1)return Response.json({status:'failed',output:[],error:{reason:'max_output_tokens'}});
   retrySignal=options.signal;ready();
   return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  }});
 router.listen(0,'127.0.0.1');await once(router,'listening');
 context.after(async()=>{router.closeAllConnections();await new Promise(r=>router.close(r));});
 const controller=new AbortController();
 const request=fetch(`http://127.0.0.1:${router.address().port}/v1/responses`,{method:'POST',signal:controller.signal,headers:{'content-type':'application/json',authorization:'Bearer test'},body:JSON.stringify({model:'opencode/test',input:history(3)})}).then(r=>r.text()).catch(()=>{});
 await retryStarted;controller.abort();await request;
 for(let i=0;i<100&&!retrySignal.aborted;i++)await new Promise(r=>setTimeout(r,2));
 assert.equal(retrySignal.aborted,true);assert.equal(count,2);
});

test('retry body read failures terminate safely instead of escaping as unhandled stream errors',async()=>{
 const failed=JSON.stringify({status:'failed',output:[],error:{reason:'max_output_tokens'}});
 const stream=answerOnlyStream('application/json',4096,{retry:async()=>new Response(new ReadableStream({start(controller){controller.error(new Error('PRIVATE upstream failure'));}}))});
 const chunks=[];
 for await(const chunk of Readable.from([Buffer.from(failed)]).pipe(stream))chunks.push(chunk);
 const result=JSON.parse(Buffer.concat(chunks).toString());
 assert.equal(result.status,'failed');assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
});

test('encrypted history expansion keeps the recovery instruction after recent user/tool history',async context=>{
 const sent=[];
 const router=createRouter({authenticate:()=>true,bridgeKey:()=> 'test',summaryModel:'gpt-test',catalog:{models:[{slug:'opencode/test',router_provider:'opencode'},{slug:'gpt-test',router_provider:'openai'}]},fetcher:async(_url,options)=>{
  const body=JSON.parse(options.body);
  if(!body.instructions?.startsWith('Produce only'))sent.push(body);
  return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}]});
 }});
 router.listen(0,'127.0.0.1');await once(router,'listening');
 context.after(async()=>{router.closeAllConnections();await new Promise(r=>router.close(r));});
 const response=await fetch(`http://127.0.0.1:${router.address().port}/v1/responses`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test'},body:JSON.stringify({model:'opencode/test',prompt_cache_key:'thread-review',tools:[{type:'function',name:'unsafe'}],input:[{type:'compaction',encrypted_content:'fixture'},...history(3)]})});
 assert.equal(response.status,200);await response.text();assert.equal(sent.length,1);
 assert.deepEqual(sent[0].tools,[]);assert.equal(sent[0].tool_choice,'none');
 assert.equal(sent[0].input.at(-1).role,'developer');assert.match(sent[0].input.at(-1).content,/Tool execution is paused/);
 assert.ok(sent[0].input.findIndex(i=>i.role==='user'&&i.content==='check and answer')<sent[0].input.length-1);
});

test('empty recovery shares one retry budget with length and preserves explicit limits',async context=>{
 for(const stream of [false,true])for(const mode of ['success','repeat-empty','then-length','tool','completed-empty','explicit-cap','overlapping-reasons','retry-unavailable']){
  const calls=[],metrics=[];
  const empty={status:'failed',output:[],error:{reason:'empty_output'}};
  const wrap=value=>stream?new Response(`event: response.${value.status}\ndata: ${JSON.stringify({type:'response.'+value.status,response:value})}\n\n`,{headers:{'content-type':'text/event-stream'}}):Response.json(value);
  const router=createRouter({authenticate:()=>true,bridgeKey:()=> 'test',catalog:{models:[{slug:'opencode/test',router_provider:'opencode'}]},onMetric:m=>metrics.push(m),fetcher:async(_url,options)=>{
   calls.push(JSON.parse(options.body));
   if(calls.length===1)return wrap(mode==='completed-empty'?{status:'completed',output:[]}:mode==='overlapping-reasons'?{...empty,incomplete_details:{reason:'max_output_tokens'}}:empty);
   if(mode==='retry-unavailable')return Response.json({error:{type:'server_error',message:'Upstream request failed: Endpoint is unavailable.'}},{status:503});
   if(mode==='repeat-empty')return wrap(empty);
   if(mode==='then-length')return wrap({status:'failed',output:[],error:{reason:'max_output_tokens'}});
   return wrap({status:'completed',output:mode==='tool'?[{type:'function_call',name:'unsafe',call_id:'unsafe'}]:[{type:'message',content:[{type:'output_text',text:'ANSWER'}]}]});
  }});
  router.listen(0,'127.0.0.1');await once(router,'listening');
  try{
   const response=await fetch(`http://127.0.0.1:${router.address().port}/v1/responses`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test'},body:JSON.stringify({model:'opencode/test',tools:[{type:'function',name:'unsafe'}],input:history(3),stream,...(['explicit-cap','overlapping-reasons'].includes(mode)?{max_output_tokens:512}:{})})});
   const text=await response.text();assert.equal(calls.length,2);
   for(const c of calls){assert.deepEqual(c.tools,[]);assert.equal(c.tool_choice,'none');assert.equal(c.max_output_tokens,['explicit-cap','overlapping-reasons'].includes(mode)?512:8192);}
   assert.deepEqual(calls[0].input,calls[1].input);
   assert.doesNotMatch(text,/unsafe|function_call/);
   if(['repeat-empty','then-length','tool','retry-unavailable'].includes(mode))assert.match(text,/failed/);else assert.match(text,/ANSWER/);
   await new Promise(r=>setImmediate(r));assert.equal(metrics.at(-1).recovery_empty_retries,1);
  }finally{router.closeAllConnections();await new Promise(r=>router.close(r));}
 }
});
