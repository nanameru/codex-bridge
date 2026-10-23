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
