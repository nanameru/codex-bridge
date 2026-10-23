import assert from "node:assert/strict";
import test from "node:test";
import { budgetHistoryBoundary, budgetToolBoundary, compactionHandoff } from "../src/compaction-handoff.mjs";

test("intra-turn boundaries keep parallel and unresolved tool exchanges intact", () => {
  const call = (call_id) => ({ type: "function_call", call_id, name: "read", arguments: "{}" });
  const output = (call_id) => ({ type: "function_call_output", call_id, output: "done" });
  const user = { role: "user", content: "continue" };
  assert.equal(budgetToolBoundary([user, call("a"), call("b"), output("a"), user, output("b"), call("pending")]), 6);
  assert.equal(budgetToolBoundary([user, call("pending"), call("a"), output("a"), user]), -1);
  assert.equal(budgetToolBoundary([user, call("a"), output("a"), call("b"), output("b"), call("pending")]), 3);
  assert.equal(budgetToolBoundary([user, call("a"), output("a")]), -1);
  assert.equal(budgetToolBoundary([user, call(undefined), output(undefined), user]), -1);
  assert.equal(budgetToolBoundary(undefined), -1);
});

test("budget boundary keeps recent turns and never splits a tool execution across user steering", () => {
  const user = (content) => ({ role: "user", content });
  const call = { type: "custom_tool_call", call_id: "pending", name: "edit", input: "patch" };
  const output = { type: "custom_tool_call_output", call_id: "pending", output: "ok" };
  assert.equal(budgetHistoryBoundary([user("old"), { role: "assistant", content: "done" }, user("recent"), user("latest")]), 2);
  assert.equal(budgetHistoryBoundary([user("old"), call, user("steering"), output, user("latest")]), -1);
  assert.equal(budgetHistoryBoundary([user("old"), user("recent"), call, user("steering"), output, user("latest")]), 1);
  assert.equal(budgetHistoryBoundary([user("only")]), -1);
  assert.equal(budgetHistoryBoundary([user("old"), call, user("latest")]), -1);
  assert.equal(budgetHistoryBoundary([user("old"), { ...call, call_id: undefined }, user("latest")]), -1);
  assert.equal(budgetHistoryBoundary(undefined), -1);
});

test("explicit history handoff preserves directives and unresolved current tools without needing a compaction item", async () => {
  const input = [
    { role: "developer", content: "constraints" }, { role: "user", content: "old request" },
    { role: "assistant", content: "old answer" }, { role: "user", content: "current request" },
    { type: "function_call", call_id: "in-progress", name: "noop", arguments: "{}" },
  ];
  let calls = 0;
  const expand = compactionHandoff({ model: "gpt-test", maxBytes: 10000, fetcher: async (_url, init) => {
    calls++;
    const sent = JSON.parse(init.body);
    assert.equal(sent.input.some((item) => item.role === "developer"), false);
    assert.equal(sent.input.some((item) => item.call_id === "in-progress"), false);
    return completed();
  } });
  const result = await expand({ input }, { ...options(), prefixEnd: 3 });
  assert.deepEqual(result.input[0], input[0]);
  assert.deepEqual(result.input.slice(-2), input.slice(-2));
  assert.equal(input[1].content, "old request");
  for (const prefixEnd of [0, -1, input.length, 1.5]) {
    await assert.rejects(expand({ input }, { ...options(), prefixEnd }), /境界/);
  }
  assert.equal(calls, 1);
});

const body = { input: [
  { role: "developer", content: "constraints" },
  { type: "compaction", id: "old-id", encrypted_content: "opaque" },
  { role: "user", content: "latest" },
] };
const options = () => ({ destination: "https://chatgpt.com/backend-api/codex",
  headers: { authorization: "Bearer test", "chatgpt-account-id": "account" },
  signal: new AbortController().signal, threadId: "thread" });
const completed = () => Response.json({ status: "completed", output: [
  { type: "message", content: [{ type: "output_text", text: "handoff" }] },
] });

test("repairs legacy custom tool IDs in native handoff summaries without editing history", async () => {
  const legacy = { type: "custom_tool_call", id: "fc_legacy", call_id: "call_legacy", name: "apply_patch", input: "patch" };
  const output = { type: "custom_tool_call_output", call_id: "call_legacy", output: "ok" };
  const input = [legacy, output, ...body.input];
  const expand = compactionHandoff({ model: "gpt-test", maxBytes: 10000,
    fetcher: async (_url, init) => {
      const sent = JSON.parse(init.body).input;
      assert.deepEqual(sent.slice(0, 2), [{ ...legacy, id: "ctc_legacy" }, output]);
      return completed();
    } });
  await expand({ input }, options());
  assert.equal(legacy.id, "fc_legacy");
});

test("releases a completed SSE handoff without waiting for the connection to close", { timeout: 2000 }, async () => {
  let cancelled = false;
  const expand = compactionHandoff({ model: "gpt-test", maxBytes: 10000,
    fetcher: async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify({ type: "response.completed",
        response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "handoff" }] }] },
      }) + "\n\n"));
    }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }) });
  const result = await expand(body, options());
  assert.match(result.input[1].content[0].text, /handoff/);
  assert.equal(cancelled, true);
});

test("reuses handoff despite instruction and display metadata changes, preserving current instructions", async () => {
  let calls = 0;
  const expand = compactionHandoff({ model: "gpt-test", maxBytes: 10000,
    fetcher: async () => { calls++; return completed(); } });
  await expand(body, options());
  const changed = structuredClone(body);
  changed.input[0].content = "new constraints";
  changed.input[1].id = "new-id";
  changed.input[1].status = "completed";
  const result = await expand(changed, options());
  assert.equal(calls, 1);
  assert.equal(result.input[0].content, "new constraints");
  assert.equal(result.input.at(-1).content, "latest");
  assert.equal(body.input[1].id, "old-id");
});

test("deduplicates concurrent summaries and a cancelled waiter does not cancel another", async () => {
  let release;
  let calls = 0;
  let upstreamSignal;
  const gate = new Promise((resolve) => { release = resolve; });
  const expand = compactionHandoff({ model: "gpt-test", maxBytes: 10000,
    fetcher: async (_url, init) => { calls++; upstreamSignal = init.signal; await gate; return completed(); } });
  const abort = new AbortController();
  const first = expand(body, { ...options(), signal: abort.signal });
  const second = expand(body, options());
  abort.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(upstreamSignal.aborted, false);
  release();
  assert.equal((await second).input[1].content[0].text.includes("handoff"), true);
  assert.equal(calls, 1);
});

test("isolates threads, credentials and changed history; failed summaries are retried", async () => {
  let calls = 0;
  const expand = compactionHandoff({ model: "gpt-test", maxBytes: 10000, retryDelayMs: 0,
    fetcher: async () => { calls++; return calls <= 2 ? new Response("", { status: 503 }) : completed(); } });
  await assert.rejects(expand(body, options()));
  await expand(body, options());
  await expand(body, { ...options(), threadId: "other" });
  await expand(body, { ...options(), headers: { authorization: "Bearer other" } });
  const changed = structuredClone(body);
  changed.input[1].encrypted_content = "different";
  await expand(changed, options());
  assert.equal(calls, 6);
});

test("does not cache requests lacking a usable thread ID", async () => {
  let calls = 0;
  const expand = compactionHandoff({ model: "gpt-test", maxBytes: 10000,
    fetcher: async () => { calls++; return completed(); } });
  for (const threadId of [undefined, undefined, "", "", "x".repeat(201)]) {
    await expand(body, { ...options(), threadId });
  }
  assert.equal(calls, 5);
});

test("handles cancellation during synchronous fetch setup before waiter registration", async () => {
  const abort = new AbortController();
  const expand = compactionHandoff({ model: "gpt-test", maxBytes: 10000,
    fetcher: async () => { abort.abort(); return completed(); } });
  await assert.rejects(expand(body, { ...options(), signal: abort.signal }), { name: "AbortError" });
});

test("aborts generation when all waiters leave and never caches its result", async () => {
  let calls = 0;
  const expand = compactionHandoff({ model: "gpt-test", maxBytes: 10000,
    fetcher: async (_url, init) => {
      calls++;
      if (calls > 1) return completed();
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort",
        () => reject(init.signal.reason), { once: true }));
    } });
  const abort = new AbortController();
  const pending = expand(body, { ...options(), signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await expand(body, options());
  assert.equal(calls, 2);
});

test('temporary summary response.failed recovers once and caches only the completed retry',async()=>{
 let calls=0;const diagnostics=[];
 const expand=compactionHandoff({model:'gpt-test',maxBytes:10000,retryDelayMs:0,fetcher:async()=>{
  if(++calls===1)return new Response('data: '+JSON.stringify({type:'response.failed',response:{status:'failed',error:{code:'server_error',message:'PRIVATE_SENTINEL'}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
  return completed();
 }});
 const original=structuredClone(body);
 await expand(body,{...options(),diagnose:d=>diagnostics.push(d)});
 await expand(body,options());
 assert.equal(calls,2);assert.deepEqual(body,original);
 assert.ok(diagnostics.some(d=>d.summary_error_code==='server_error'&&d.summary_attempts===1));
 assert.doesNotMatch(JSON.stringify(diagnostics),/PRIVATE_SENTINEL/);
});

test('permanent and unknown summary errors expose only safe codes without retrying',async()=>{
 for(const code of ['invalid_encrypted_content','invalid_prompt','PRIVATE_SENTINEL']){
  let calls=0;
  const expand=compactionHandoff({model:'gpt-test',maxBytes:10000,retryDelayMs:0,fetcher:async()=>{
   calls++;return Response.json({status:'failed',error:{code,message:'PRIVATE_SENTINEL'},output:[]});
  }});
  await assert.rejects(expand(body,options()),error=>{
   assert.equal(error.upstreamCode,code==='PRIVATE_SENTINEL'?'unknown_error':code);
   assert.doesNotMatch(error.message,/PRIVATE_SENTINEL/);return true;
  });assert.equal(calls,1);
 }
 for(const status of [400,401,403,429]){
  let calls=0;
  const expand=compactionHandoff({model:'gpt-test',maxBytes:10000,retryDelayMs:0,fetcher:async()=>{
   calls++;return new Response('PRIVATE_SENTINEL',{status});
  }});
  await assert.rejects(expand(body,options()),error=>{
   assert.equal(error.upstreamStatus,status);assert.doesNotMatch(error.message,/PRIVATE_SENTINEL/);return true;
  });assert.equal(calls,1);
 }
});

test('summary transient failures stop at two attempts and keep failure metadata',async()=>{
 let calls=0;
 const expand=compactionHandoff({model:'gpt-test',maxBytes:10000,retryDelayMs:0,fetcher:async()=>{
  calls++;return new Response('',{status:503});
 }});
 await assert.rejects(expand(body,options()),error=>{
  assert.equal(error.upstreamStatus,503);assert.equal(error.attempts,2);return true;
 });assert.equal(calls,2);
});

test('cancelling during summary retry wait prevents a second upstream request',async()=>{
 let calls=0;const abort=new AbortController();
 const expand=compactionHandoff({model:'gpt-test',maxBytes:10000,retryDelayMs:1000,fetcher:async()=>{
  calls++;return new Response('',{status:503});
 }});
 await assert.rejects(expand(body,{...options(),signal:abort.signal,diagnose:d=>{
  if(d.summary_retrying)abort.abort();
 }}),{name:'AbortError'});assert.equal(calls,1);
});

test('empty, truncated and token-limited summaries recover once and cache only a complete result',async()=>{
 for(const transport of ['json','sse'])for(const reason of ['empty','max_output_tokens',...(transport==='sse'?['missing_terminal']:[])]){
  let calls=0;const sent=[],diagnostics=[];
  const expand=compactionHandoff({model:'gpt-test',maxBytes:100000,retryDelayMs:0,fetcher:async(_url,args)=>{
   sent.push(JSON.parse(args.body));calls++;
   if(calls>1)return completed();
   const response=reason==='empty'?{status:'completed',output:[{type:'reasoning',encrypted_content:'PRIVATE'}]}:{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'message',content:[{type:'output_text',text:'PRIVATE PARTIAL'}]}]};
   if(transport==='json')return Response.json(response);
   const event=reason==='missing_terminal'?{type:'response.output_text.delta',delta:'PRIVATE PARTIAL'}:{type:'response.'+response.status,response};
   return new Response('data: '+JSON.stringify(event)+'\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  const original=structuredClone(body);
  const result=await expand(body,{...options(),diagnose:d=>diagnostics.push(d)});
  assert.equal(calls,2);assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);assert.deepEqual(body,original);
  assert.equal(sent[0].max_output_tokens,8192);assert.equal(sent[1].max_output_tokens,reason==='max_output_tokens'?16384:8192);
  assert.deepEqual(sent[0].input,sent[1].input);assert.deepEqual(sent[1].tools,[]);
  assert.ok(diagnostics.some(d=>d.summary_error_code===(reason==='empty'?'empty_summary':reason==='max_output_tokens'?'summary_max_output_tokens':'summary_stream_truncated')));
  await expand(body,options());assert.equal(calls,2);
 }
});

test('summary validation distinguishes permanent failures and never forwards partial/private summaries',async()=>{
 const cases=[
  [{status:'incomplete',incomplete_details:{reason:'content_filter'},output:[]},'content_filter'],
  [{status:'incomplete',incomplete_details:{reason:'PRIVATE'}},'summary_incomplete'],
  [{status:'completed',output:[{type:'function_call',name:'unsafe'}]},'summary_unexpected_item'],
  [{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'PRIVATE'}]}]},'content_filter'],
  [{status:'completed',output:[{type:'message',status:'in_progress',content:[{type:'output_text',text:'PRIVATE PARTIAL'}]}]},'summary_invalid_response'],
  [{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'PRIVATE'.repeat(10000)}]}]},'summary_too_large'],
  [{status:'completed',output:'PRIVATE'},'summary_invalid_response'],
 ];
 for(const transport of ['json','sse'])for(const [response,code]of cases){
  let calls=0;const diagnostics=[];
  const expand=compactionHandoff({model:'gpt-test',maxBytes:100000,retryDelayMs:0,fetcher:async()=>{
   calls++;
   return transport==='json'?Response.json(response):new Response('data: '+JSON.stringify({type:'response.'+response.status,response})+'\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  await assert.rejects(expand(body,{...options(),diagnose:d=>diagnostics.push(d)}),error=>{assert.equal(error.upstreamCode,code);assert.doesNotMatch(error.message,/PRIVATE/);return true;});
  assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(diagnostics),/PRIVATE|unsafe/);
 }
});

test('two incomplete/empty attempts stop without caching, and a later request can recover',async()=>{
 for(const reason of ['empty','max_output_tokens']){
  let calls=0;
  const expand=compactionHandoff({model:'gpt-test',maxBytes:100000,retryDelayMs:0,fetcher:async()=>{
   if(++calls>2)return completed();
   return Response.json(reason==='empty'?{status:'completed',output:[]}:{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[]});
  }});
  await assert.rejects(expand(body,options()),error=>{assert.equal(error.attempts,2);return true;});assert.equal(calls,2);
  await expand(body,options());assert.equal(calls,3);
 }
});

test('incomplete SSE is terminal even if the server keeps the connection open',async()=>{
 let calls=0,cancelled=false;
 const expand=compactionHandoff({model:'gpt-test',maxBytes:100000,retryDelayMs:0,fetcher:async()=>{
  if(++calls>1)return completed();
  return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'response.incomplete',response:{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}})+'\n\n'));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
 }});
 await expand(body,options());assert.equal(calls,2);assert.equal(cancelled,true);
});

test('cancelling a token-limited summary during retry backoff prevents regeneration',async()=>{
 let calls=0;const abort=new AbortController();
 const expand=compactionHandoff({model:'gpt-test',maxBytes:100000,retryDelayMs:1000,fetcher:async()=>{calls++;return Response.json({status:'incomplete',incomplete_details:{reason:'max_output_tokens'}});}});
 await assert.rejects(expand(body,{...options(),signal:abort.signal,diagnose:d=>{if(d.summary_retrying)abort.abort();}}),{name:'AbortError'});
 assert.equal(calls,1);
});

test('native thin terminal uses completed output items, not partial deltas, and caches the summary', async () => {
  let calls = 0; const diagnostics = [];
  const expand = compactionHandoff({ model: 'gpt-test', maxBytes: 100000, retryDelayMs: 0, fetcher: async () => {
    calls++;
    const events = [
      { type: 'response.output_text.delta', delta: 'PRIVATE PARTIAL' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_done', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Completed factual handoff.' }] } },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ];
    return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const result = await expand(body, { ...options(), diagnose: d => diagnostics.push(d) });
  assert.match(JSON.stringify(result), /Completed factual handoff/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  await expand(body, options()); assert.equal(calls, 1);
  assert.ok(diagnostics.some(d => d.summary_output_source === 'completed_items'));
});

test('thin terminal restores ordered completed messages across UTF8 chunks and never exposes reasoning', async () => {
 const item={type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'日本語の引き継ぎ✅'}]};
 const events=[{type:'response.output_item.done',output_index:1,item},
  {type:'response.output_item.done',output_index:0,item:{type:'reasoning',encrypted_content:'PRIVATE REASONING'}},
  {type:'response.completed',response:{status:'completed',output:[]}}];
 const bytes=new TextEncoder().encode(events.map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join(''));
 const expand=compactionHandoff({model:'gpt-test',maxBytes:100000,fetcher:async()=>new Response(new ReadableStream({start(c){for(let n=0;n<bytes.length;n+=7)c.enqueue(bytes.slice(n,n+7));c.close();}}),{headers:{'content-type':'text/event-stream'}})});
 const result=JSON.stringify(await expand(body,options()));
 assert.match(result,/日本語の引き継ぎ✅/);assert.doesNotMatch(result,/PRIVATE/);
});

test('completed items never bypass terminal status, item validation, or authoritative terminal output', async () => {
 const message={type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'PRIVATE STREAM'}]};
 for(const scenario of ['delta_only','missing_terminal','failed','incomplete','gap','duplicate','unexpected','unfinished','refusal','role','terminal']){
  let calls=0;const diagnostics=[];
  const item=scenario==='unexpected'?{type:'function_call',name:'unsafe'}:scenario==='refusal'?{...message,content:[{type:'refusal',refusal:'PRIVATE'}]}:scenario==='unfinished'?{...message,status:'in_progress'}:scenario==='role'?{...message,role:'user'}:message;
  const events=[{type:'response.output_text.delta',delta:'PRIVATE DELTA'}];
  if(scenario!=='delta_only')events.push({type:'response.output_item.done',output_index:scenario==='gap'?1:0,item});
  if(scenario==='duplicate')events.push(events.at(-1));
  if(scenario!=='missing_terminal')events.push(scenario==='failed'?{type:'response.failed',response:{status:'failed',error:{code:'invalid_prompt'}}}:scenario==='incomplete'?{type:'response.incomplete',response:{status:'incomplete',incomplete_details:{reason:'content_filter'},output:[]}}:{type:'response.completed',response:{status:'completed',output:scenario==='terminal'?[{...message,content:[{type:'output_text',text:'Authoritative final summary'}]}]:[]}});
  const expand=compactionHandoff({model:'gpt-test',maxBytes:100000,retryDelayMs:0,fetcher:async()=>{calls++;return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});}});
  if(scenario==='terminal'){
   const result=JSON.stringify(await expand(body,{...options(),diagnose:d=>diagnostics.push(d)}));
   assert.match(result,/Authoritative final summary/);assert.doesNotMatch(result,/PRIVATE/);
  }else await assert.rejects(expand(body,{...options(),diagnose:d=>diagnostics.push(d)}));
  assert.equal(calls,['delta_only','missing_terminal'].includes(scenario)?2:1,scenario);
  assert.doesNotMatch(JSON.stringify(diagnostics),/PRIVATE|unsafe/);
 }
});

test('pre-response connection timeouts recover once within the shared summary attempt budget', async () => {
 for (const cause of [{code:'ETIMEDOUT'}, {code:'UND_ERR_CONNECT_TIMEOUT'}, {errors:[{code:'EHOSTUNREACH'},{code:'ETIMEDOUT'}]}]) {
  let calls=0;const diagnostics=[];
  const expand=compactionHandoff({model:'gpt-test',maxBytes:100000,retryDelayMs:0,fetcher:async()=>{
   if(++calls===1)throw new TypeError('PRIVATE HOST',{cause});return completed();
  }});
  const result=await expand(body,{...options(),diagnose:d=>diagnostics.push(d)});
  assert.equal(calls,2);assert.ok(JSON.stringify(result).length>0);
  assert.ok(diagnostics.some(d=>d.summary_error_code==='summary_connect_timeout'&&d.summary_retrying));
  assert.doesNotMatch(JSON.stringify(diagnostics),/PRIVATE|EHOSTUNREACH/);
 }
});

test('two connection timeouts stop without HTTP status or poisoned cache', async () => {
 let calls=0;
 const expand=compactionHandoff({model:'gpt-test',maxBytes:100000,retryDelayMs:0,fetcher:async()=>{
  if(++calls<=2)throw new TypeError('PRIVATE HOST',{cause:{code:'ETIMEDOUT'}});return completed();
 }});
 await assert.rejects(expand(body,options()),e=>{
  assert.equal(e.attempts,2);assert.equal(e.upstreamCode,'summary_connect_timeout');
  assert.equal(e.upstreamStatus,undefined);assert.doesNotMatch(e.message,/PRIVATE|HTTP undefined|HTTP 0/);return true;
 });
 await expand(body,options());assert.equal(calls,3);
});

test('connection recovery never retries cancellation, unknown transport errors or failures after HTTP headers', async () => {
 for(const scenario of ['cancel','unknown','headers']){
  let calls=0;const abort=new AbortController();
  const expand=compactionHandoff({model:'gpt-test',maxBytes:100000,retryDelayMs:1000,fetcher:async()=>{
   calls++;
   if(scenario==='headers')return new Response(new ReadableStream({start(c){c.error(new TypeError('PRIVATE',{cause:{code:'ETIMEDOUT'}}));}}));
   throw new TypeError('PRIVATE',{cause:{code:scenario==='unknown'?'PRIVATE_CODE':'ETIMEDOUT'}});
  }});
  await assert.rejects(expand(body,{...options(),signal:abort.signal,diagnose:d=>{if(scenario==='cancel'&&d.summary_retrying)abort.abort();}}));
  assert.equal(calls,1,scenario);
 }
});
