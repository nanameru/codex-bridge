import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createRouter, routedBody } from "../src/model-router.mjs";
import { HandoffStatus, WAIT_TEXT, BUDGET_TEXT, isHandoffStatusItem, readUpstreamFailure } from "../src/handoff-status.mjs";

const catalog = { models: [
  { slug: "gpt-test", router_provider: "openai" },
  { slug: "opencode/test", router_model: "test", router_provider: "opencode", router_transport: "responses" },
] };
const requestBody = { model: "opencode/test", stream: true, prompt_cache_key: "thread-A",
  input: [{ type: "compaction", encrypted_content: "native-private-history" }, { role: "user", content: "continue" }] };
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
const event = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
function upstreamSse() {
  const item = { id: "msg_upstream", type: "message", role: "assistant", content: [{ type: "output_text", text: "ANSWER", annotations: [] }] };
  const result = { id: "resp_upstream", status: "completed", output: [item] };
  return event("response.created", { sequence_number: 0, response: { ...result, status: "in_progress", output: [] } })
    + event("response.output_item.added", { sequence_number: 1, output_index: 0, item: { ...item, status: "in_progress", content: [] } })
    + event("response.output_text.delta", { sequence_number: 2, output_index: 0, item_id: item.id, content_index: 0, delta: "ANSWER" })
    + event("response.output_item.done", { sequence_number: 3, output_index: 0, item })
    + event("response.completed", { sequence_number: 4, response: result });
}
function events(text) {
  return text.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => JSON.parse(frame.split(/\r?\n/)
    .filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")));
}
async function prefix(response, expected = WAIT_TEXT) {
  const reader = response.body.getReader();
  let text = "";
  while (!text.includes(expected)) {
    const next = await reader.read();
    assert.equal(next.done, false, "waiting message must precede completion");
    text += new TextDecoder().decode(next.value);
  }
  return { text, reader };
}
async function remainder(reader) {
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const next = await reader.read();
    if (next.done) return text + decoder.decode();
    text += decoder.decode(next.value, { stream: true });
  }
}
async function fixture(context, options = {}) {
  const gate = deferred();
  const calls = [];
  let summarySignal;
  const server = createRouter({ catalog, summaryModel: "gpt-test", handoffStatusDelayMs: 1,
    allowTestOrigins: true, nativeBase: "http://127.0.0.1:9999/v1", authenticate: () => true,
    bridgeKey: () => "internal-test-key", timeoutMs: 3000,
    fetcher: async (url, args) => {
      const body = JSON.parse(args.body);
      calls.push({ body, headers: args.headers });
      if (body.instructions?.startsWith("Produce only")) {
        summarySignal = args.signal;
        await Promise.race([gate.promise, new Promise((_r, reject) => args.signal.addEventListener("abort", () => reject(args.signal.reason), { once: true }))]);
        if (options.failSummary) return new Response("PRIVATE upstream error", { status: 503 });
        return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "PORTABLE SUMMARY" }] }] });
      }
      if (options.upstreamError) return Response.json(options.upstreamError, { status: options.upstreamStatus ?? 400 });
      if (options.failUpstream) return new Response("PRIVATE upstream error", { status: 429 });
      if (options.jsonUpstream) return Response.json({ id: "resp_json", status: "completed", output: [
        { id: "msg_json", type: "message", role: "assistant", content: [{ type: "output_text", text: "ANSWER" }] }] });
      if (options.toolsUpstream) {
        const item = { id: "fc_probe", type: "function_call", call_id: "probe", name: "exec", arguments: '{"input":"printf check"}' };
        return new Response(event("response.created", { response: { id: "resp_tools", output: [] } })
          + event("response.output_item.added", { output_index: 0, item })
          + event("response.output_item.done", { output_index: 0, item })
          + event("response.completed", { response: { id: "resp_tools", status: "completed", output: [item] } }),
          { headers: { "content-type": "text/event-stream" } });
      }
      if (options.split) {
        const bytes = Buffer.from(upstreamSse().replace(/ANSWER/g, "日本語の応答"));
        return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }),
          { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(upstreamSse(), { headers: { "content-type": "text/event-stream" } });
    }, ...options.router });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => { gate.resolve(); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const send = (body = requestBody) => fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
    method: "POST", headers: { authorization: "Bearer native-test-key", "content-type": "application/json", "x-codex-bridge-direct": "1" }, body: JSON.stringify(body) });
  return { gate, calls, send, summarySignal: () => summarySignal };
}

test("App/CLI progress arrives while summary is pending; response IDs, indexes and sequences remain consistent", { timeout: 5000 }, async (context) => {
  const { gate, calls, send } = await fixture(context);
  const response = await send();
  const first = await prefix(response);
  assert.equal(calls.length, 1);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  gate.resolve();
  const stream = events(first.text + await remainder(first.reader));
  assert.equal(stream.filter((e) => e.type === "response.created").length, 1);
  assert.deepEqual(stream.map((e) => e.sequence_number), stream.map((_e, i) => i));
  const done = stream.at(-1);
  assert.equal(done.type, "response.completed");
  assert.equal(done.response.id, stream[0].response.id);
  assert.equal(done.response.output.length, 2);
  assert.ok(isHandoffStatusItem(done.response.output[0]));
  assert.equal(done.response.output[1].id, "msg_upstream");
  assert.match(done.response.output[0].summary[0].text, /履歴変換完了/);
  assert.equal(stream.find((e) => e.type === "response.output_item.done" && e.item.id === "msg_upstream").output_index, 1);
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(done.response.output[0].type, "reasoning");
  assert.equal(stream.some(e => e.type === "response.output_text.delta" && e.item_id === done.response.output[0].id), false);
  assert.doesNotMatch(JSON.stringify(calls[1].body), /native-private-history/);
});

test("cache hits, immediate handoffs and native requests do not inject status", { timeout: 5000 }, async (context) => {
  const { gate, send, calls } = await fixture(context, { router: { handoffStatusDelayMs: 50 } });
  gate.resolve();
  for (const body of [requestBody, requestBody, { model: "gpt-test", stream: true, input: [{ role: "user", content: "native" }] }]) {
    assert.doesNotMatch(await (await send(body)).text(), /rs_bridge_handoff_|msg_bridge_handoff_/);
  }
  assert.equal(calls.filter((c) => c.body.instructions?.startsWith("Produce only")).length, 1);
});

test("non-stream requests preserve JSON and failure HTTP status", { timeout: 5000 }, async (context) => {
  const { gate, send } = await fixture(context, { jsonUpstream: true });
  gate.resolve();
  const response = await send({ ...requestBody, stream: false });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, "resp_json");
  const failing = await fixture(context, { failSummary: true });
  failing.gate.resolve();
  assert.equal((await failing.send({ ...requestBody, stream: false })).status, 502);
});

test("a failed handoff sends a terminal failure after status without dropping history or leaking upstream bodies", { timeout: 5000 }, async (context) => {
  const { gate, calls, send } = await fixture(context, { failSummary: true });
  const response = await send();
  const first = await prefix(response);
  gate.resolve();
  const text = first.text + await remainder(first.reader);
  const stream = events(text);
  assert.equal(stream.at(-1).type, "response.failed");
  assert.match(stream.at(-1).response.error.message, /compaction_handoff_failed/);
  assert.equal(stream.at(-1).response.error.code, "invalid_prompt");
  assert.doesNotMatch(text, /PRIVATE/);
  assert.doesNotMatch(text, /Working|履歴変換完了|要約完了/);
  assert.equal(calls.length, 2);
  assert.equal(requestBody.input[0].encrypted_content, "native-private-history");
});

test("upstream errors after handoff remain failures rather than successful completed answers", { timeout: 5000 }, async (context) => {
  const { gate, send } = await fixture(context, { failUpstream: true });
  const response = await send();
  const first = await prefix(response);
  gate.resolve();
  const text = first.text + await remainder(first.reader);
  assert.equal(events(text).at(-1).type, "response.failed");
  assert.match(text, /HTTP 429/);
  assert.equal(events(text).at(-1).response.error.code, "rate_limit_exceeded");
  assert.doesNotMatch(text, /PRIVATE/);
});

test("split UTF-8 SSE and JSON upstreams preserve final model text", { timeout: 5000 }, async (context) => {
  for (const options of [{ split: true }, { jsonUpstream: true }]) {
    const { gate, send } = await fixture(context, options);
    const response = await send();
    const first = await prefix(response);
    gate.resolve();
    const stream = events(first.text + await remainder(first.reader));
    assert.equal(stream.at(-1).type, "response.completed");
    assert.equal(stream.at(-1).response.output[1].content[0].text, options.split ? "日本語の応答" : "ANSWER");
  }
});

test("shared waiters receive independent statuses and one summary", { timeout: 5000 }, async (context) => {
  const { gate, send, calls } = await fixture(context);
  const responses = await Promise.all([send(), send()]);
  const first = await Promise.all(responses.map(prefix));
  assert.equal(calls.length, 1);
  assert.ok(first.some(x => x.text.includes("共有処理の完了待ち")));
  gate.resolve();
  const streams = await Promise.all(first.map(async (x) => events(x.text + await remainder(x.reader))));
  assert.notEqual(streams[0][0].response.id, streams[1][0].response.id);
  assert.equal(calls.length, 3);
});

test("closing the waiting client cancels its summary and timeout terminates the status stream", { timeout: 5000 }, async (context) => {
  const { send, summarySignal } = await fixture(context);
  const first = await prefix(await send());
  await first.reader.cancel();
  for (let i = 0; i < 100 && !summarySignal().aborted; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(summarySignal().aborted, true);
  const timed = await fixture(context, { router: { timeoutMs: 40 } });
  const response = await timed.send();
  const early = await prefix(response);
  assert.equal(events(early.text + await remainder(early.reader)).at(-1).type, "response.failed");
});

test("bridge-only status is not replayed as model context; ordinary commentary and all user data remain", () => {
  const status = { type: "message", id: "msg_bridge_handoff_test", role: "assistant", phase: "commentary", content: "status" };
  const ordinary = { ...status, id: "msg_ordinary", content: "real model commentary" };
  const user = { ...status, role: "user" };
  const input = [status, ordinary, user];
  assert.deepEqual(routedBody({ input }, { provider: "openai", model: "gpt-test" }, 10000).input, [ordinary, user]);
  assert.equal(input.length, 3);
});

test("status does not alter custom tool arguments, call IDs or response ordering", { timeout: 5000 }, async (context) => {
  const { gate, send } = await fixture(context, { toolsUpstream: true });
  const response = await send({ ...requestBody, tools: [{ type: "custom", name: "exec" }] });
  const first = await prefix(response);
  gate.resolve();
  const stream = events(first.text + await remainder(first.reader));
  const output = stream.at(-1).response.output;
  assert.ok(isHandoffStatusItem(output[0]));
  assert.equal(output[1].type, "custom_tool_call");
  assert.equal(output[1].call_id, "probe");
  assert.equal(output[1].input, "printf check");
  assert.equal(output[1].id, "ctc_probe");
  assert.equal(stream.find((e) => e.type === "response.output_item.done" && e.item.id === "ctc_probe").output_index, 1);
});

test("one shared client may cancel without cancelling the remaining status waiter", { timeout: 5000 }, async (context) => {
  const { gate, send, summarySignal, calls } = await fixture(context);
  const first = await Promise.all((await Promise.all([send(), send()])).map(prefix));
  await first[0].reader.cancel();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(summarySignal().aborted, false);
  gate.resolve();
  const stream = events(first[1].text + await remainder(first[1].reader));
  assert.equal(stream.at(-1).type, "response.completed");
  assert.equal(calls.length, 2);
});


test("budget summary reports input reduction rather than a model switch", async () => {
  let stream = "";
  const response = { writeHead() {}, flushHeaders() {}, write(text) { stream += text; } };
  const status = new HandoffStatus(response, { model: "opencode/test", enabled: true, delayMs: 1 });
  status.observe("miss", "budget");
  await new Promise(resolve => setTimeout(resolve, 10));
  status.ready();
  status.dispose();
  const output = events(stream);
  assert.ok(output.some(e => e.delta === BUDGET_TEXT));
  assert.ok(output.some(e => e.delta?.includes("要約完了")));
  assert.doesNotMatch(stream, /切り替えるため/);
  assert.doesNotMatch(WAIT_TEXT, /切り替えるため/);
});


test("router chooses budget notification for both new summaries and extended compacted history", { timeout: 5000 }, async context => {
  for (const compacted of [false, true]) {
    const { gate, send, calls } = await fixture(context, { router: { opencodeSoftLimitTokens: 500, opencodeHardLimitTokens: 1000 } });
    const response = await send({ ...requestBody, input: [
      ...(compacted ? [{ type: "compaction", encrypted_content: "old" }] : []),
      { role: "user", content: "x".repeat(10000) },
      { role: "user", content: "recent" }, { role: "user", content: "latest" },
    ] });
    const first = await prefix(response, BUDGET_TEXT);
    gate.resolve();
    const text = first.text + await remainder(first.reader);
    assert.match(text, /要約完了/);
    assert.doesNotMatch(text, /切り替えるため/);
    assert.equal(calls.filter(c => c.body.instructions?.startsWith("Produce only")).length, 1);
    assert.equal(calls.at(-1).body.input.at(-1).content, "latest");
  }
});


test("upstream 400 retains safe diagnostics in terminal SSE and metrics, excluding echoed secrets", async context => {
  const metrics = [];
  const { gate, send } = await fixture(context, { upstreamError: { error: {
    code: "invalid_image", type: "invalid_request_error", message: "PRIVATE Bearer sk-secret user text",
  } }, router: { onMetric: metric => metrics.push(metric) } });
  const early = await prefix(await send()); gate.resolve();
  const text = early.text + await remainder(early.reader);
  assert.equal(events(text).at(-1).type, "response.failed");
  assert.match(text, /invalid_image/);
  assert.match(text, /invalid_request_error/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(metrics.at(-1).upstream_error_code, "invalid_image");
  assert.doesNotMatch(text + JSON.stringify(metrics), /PRIVATE|sk-secret|user text/);
});

test("diagnostics bound reading and omit unknown fields even when secret-like", async () => {
  for (const [body, expected] of [
    ['not JSON PRIVATE', 'invalid_json'],
    [JSON.stringify({error:{code:'sk-secret',type:'user-private',message:'PRIVATE'}}), 'parsed'],
    ['x'.repeat(20000), 'too_large'],
  ]) {
    const detail = await readUpstreamFailure(new Response(body));
    assert.equal(detail.read, expected);
    assert.equal(detail.code, 'unknown_error');
    assert.doesNotMatch(JSON.stringify(detail), /PRIVATE|sk-secret|user-private/);
  }
  let cancelled = false;
  const detail = await readUpstreamFailure(new Response(new ReadableStream({ cancel() { cancelled = true; } })), { timeoutMs: 10 });
  assert.equal(detail.read, 'timeout');
  assert.equal(cancelled, true);
});


test("message-only upstream failures produce fixed reason categories without echoing messages", async () => {
  for (const [message, expected] of [
    ['Maximum context length reached: PRIVATE', 'context_length_exceeded'],
    ['Invalid image: sk-secret', 'invalid_image'],
    ['tool_call_id mismatch PRIVATE', 'invalid_tool_history'],
    ['Unknown private failure sk-secret', 'unknown_error'],
  ]) {
    const detail = await readUpstreamFailure(Response.json({ error: { message } }));
    assert.equal(detail.code, expected);
    assert.doesNotMatch(JSON.stringify(detail), /PRIVATE|sk-secret/);
  }
});

test("bridge conversion failures retain fixed reasons without forwarding private detail", async () => {
  for (const code of ['conflicting_current_definitions', 'unsupported_live_search', 'invalid_search_history']) {
    const detail = await readUpstreamFailure(Response.json({error:{type:'unsupported_tool_search', code,
      message:'PRIVATE user history Bearer sk-secret'}}));
    assert.deepEqual(detail, {code, type:'unsupported_tool_search', read:'parsed'});
    assert.doesNotMatch(JSON.stringify(detail), /PRIVATE|Bearer|sk-secret/);
  }
  const detail = await readUpstreamFailure(Response.json({error:{type:'unsupported_tool_search', code:'private-user-value'}}));
  assert.deepEqual(detail, {code:'unknown_error', type:'unsupported_tool_search', read:'parsed'});
});

test("handoff identifies a local conversion failure without billing or login guidance", async context => {
  const {gate,send}=await fixture(context,{upstreamStatus:422,upstreamError:{error:{
    type:'unsupported_tool_search',code:'conflicting_current_definitions',message:'PRIVATE sk-secret',
  }}});
  const early=await prefix(await send());gate.resolve();
  const text=early.text+await remainder(early.reader);
  assert.match(text,/Bridgeでツール情報または履歴の変換に失敗/);
  assert.match(text,/conflicting_current_definitions/);
  assert.doesNotMatch(text,/PRIVATE|sk-secret|ログイン|支払い|console\/go/);
  assert.equal(events(text).at(-1).type,'response.failed');
});


test("ready restores Working for both handoff modes and keeps completion in history", () => {
  for (const reason of ["budget", "handoff"]) {
    const frames = [];
    const response = { destroyed: false, writableEnded: false, writeHead() {}, flushHeaders() {},
      write(frame) { frames.push(frame); } };
    const status = new HandoffStatus(response, { model: "test", enabled: true });
    status.reason = reason;
    try {
      status.begin();
      status.ready();
      const output = events(frames.join(""));
      const deltas = output.filter(event => event.type === "response.reasoning_summary_text.delta");
      assert.equal(deltas.at(-1).delta, "\nWorking");
      const done = output.find(event => event.type === "response.output_item.done");
      const text = done.item.summary[0].text;
      assert.match(text, reason === "budget" ? /要約完了/ : /履歴変換完了/);
      assert.doesNotMatch(text, /モデルの応答待ち/);
      const count = frames.length;
      status.ready();
      assert.equal(frames.length, count);
    } finally { status.dispose(); }
  }
});
