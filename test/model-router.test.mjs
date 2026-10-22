import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import * as zlib from "node:zlib";
import { catalogRoutes, createRouter, estimateInputTokens, routedBody } from "../src/model-router.mjs";

const catalog = { models: [
  { slug: "gpt-test", router_provider: "openai" },
  { slug: "opencode/deepseek-test", router_provider: "opencode", router_model: "deepseek-test" },
  { slug: "opencode/gpt-test", router_provider: "opencode", router_model: "gpt-test" },
] };

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}/v1`;
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

async function fixture(context, options = {}) {
  const calls = [];
  const upstream = (provider) => http.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    calls.push({ provider, headers: request.headers, body: JSON.parse(text), path: request.url });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`event: response.created\ndata: ${JSON.stringify({ provider })}\n\n`);
    response.end("event: response.completed\ndata: {}\n\n");
  });
  const native = upstream("openai");
  const bridge = upstream("opencode");
  const nativeBase = await listen(native);
  const bridgeBase = await listen(bridge);
  const router = createRouter({ catalog, nativeBase, bridgeBase, allowTestOrigins: true, ...options });
  const base = await listen(router);
  context.after(async () => { await close(router); await close(native); await close(bridge); });
  const send = (body, headers = {}) => fetch(base + "/responses", {
    method: "POST", headers: { authorization: "Bearer fake-native-token", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { calls, base, send };
}

test("routes both switching directions without changing thread metadata or messages", async (context) => {
  const { calls, send } = await fixture(context);
  const input = [{ type: "message", role: "user", content: "history" }];
  for (const model of ["gpt-test", "opencode/deepseek-test", "gpt-test", "deepseek-test", "gpt-test", "deepseek-test"]) {
    const response = await send({ model, input, prompt_cache_key: "same-thread", stream: true });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response.completed/);
  }
  assert.deepEqual(calls.map((call) => call.provider), ["openai", "opencode", "openai", "opencode", "openai", "opencode"]);
  for (const call of calls) {
    assert.equal(call.body.prompt_cache_key, "same-thread");
    assert.deepEqual(call.body.input, input);
  }
});

test("never forwards native authentication or account headers to OpenCode", async (context) => {
  const { calls, send } = await fixture(context);
  for (const model of ["gpt-test", "deepseek-test"]) {
    await (await send({ model }, { "chatgpt-account-id": "account-for-test", "x-secret": "private" })).text();
  }
  assert.equal(calls[0].headers.authorization, "Bearer fake-native-token");
  assert.equal(calls[0].headers["chatgpt-account-id"], "account-for-test");
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(calls[1].headers["chatgpt-account-id"], undefined);
  assert.equal(calls[0].headers["x-secret"], undefined);
  assert.equal(calls[1].headers["x-secret"], undefined);
});

test("repairs persisted legacy custom IDs before native responses and remote compaction", async (context) => {
  const { calls, base, send } = await fixture(context);
  const input = [
    { type: "custom_tool_call", id: "fc_2020be0e36634c26", call_id: "call_original", name: "apply_patch", input: "patch" },
    { type: "custom_tool_call_output", call_id: "call_original", output: "ok" },
    { type: "function_call", id: "fc_regular", call_id: "call_regular", name: "shell", arguments: "{}" },
    { type: "custom_tool_call", id: "ctc_valid", call_id: "call_valid", name: "apply_patch", input: "valid" },
  ];
  const original = structuredClone(input);
  await (await send({ model: "gpt-test", input })).text();
  const compact = await fetch(base + "/responses/compact", { method: "POST", headers: {
    authorization: "Bearer fake-native-token", "content-type": "application/json",
  }, body: JSON.stringify({ model: "gpt-test", input }) });
  assert.equal(compact.status, 200);
  await compact.text();
  assert.deepEqual(calls.map((call) => call.path), ["/v1/responses", "/v1/responses/compact"]);
  for (const call of calls) {
    assert.deepEqual(call.body.input, [{ ...input[0], id: "ctc_2020be0e36634c26" }, ...input.slice(1)]);
  }
  assert.deepEqual(input, original);
});

test("preserves the already-deployed native image and search endpoints independently of chat models", async (context) => {
  const { base, calls } = await fixture(context);
  for (const path of ["/images/generations", "/images/edits", "/alpha/search"]) {
    const body = { model: "not-a-chat-model", input: "tool input", previous_response_id: "tool-specific-reference" };
    const response = await fetch(base + path, { method: "POST", headers: {
      "content-type": "application/json", authorization: "Bearer native-tool-token", "chatgpt-account-id": "tool-account",
    }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(calls.at(-1).provider, "openai");
    assert.equal(calls.at(-1).path, "/v1" + path);
    assert.equal(calls.at(-1).headers.authorization, "Bearer native-tool-token");
    assert.deepEqual(calls.at(-1).body, body);
  }
  assert.equal((await fetch(base + "/alpha/search?other=1", { method: "POST" })).status, 404);
});

test("rejects unknown models and missing authentication before forwarding", async (context) => {
  const { calls, send } = await fixture(context);
  assert.equal((await send({ model: "unknown" })).status, 400);
  assert.equal((await send({ model: "gpt-test" }, { authorization: "" })).status, 401);
  assert.equal(calls.length, 0);
});

test("uses explicit namespaces for overlapping models", async (context) => {
  const { calls, send } = await fixture(context);
  await (await send({ model: "opencode/gpt-test" })).text();
  assert.equal(calls[0].provider, "opencode");
  assert.equal(calls[0].body.model, "gpt-test");
  assert.equal(catalogRoutes(catalog).get("gpt-test").provider, "openai");
});

test("filters provider-specific reasoning without editing the original history", () => {
  const body = { input: [
    { type: "reasoning", encrypted_content: "cxb1:fake" },
    { type: "reasoning", encrypted_content: "native-encrypted" },
    { type: "message", role: "assistant", content: "result" },
  ] };
  assert.equal(routedBody(body, { provider: "openai", model: "gpt-test" }).input[0].encrypted_content, "native-encrypted");
  assert.equal(routedBody(body, { provider: "opencode", model: "deepseek-test" }).input[0].encrypted_content, "cxb1:fake");
  assert.equal(body.input.length, 3);
});

test("never follows redirects carrying native credentials", async (context) => {
  let count = 0;
  const { send } = await fixture(context, { fetcher: async (_url, options) => {
    count++;
    assert.equal(options.redirect, "manual");
    return new Response("", { status: 307, headers: { location: "https://example.com" } });
  } });
  const response = await send({ model: "gpt-test" });
  assert.equal(response.status, 502);
  assert.equal(count, 1);
});

test("rejects external native or bridge targets", () => {
  assert.throws(() => createRouter({ catalog, nativeBase: "https://example.com" }));
  assert.throws(() => createRouter({ catalog, bridgeBase: "https://example.com" }));
  assert.throws(() => createRouter({ catalog, bridgeBase: "http://127.0.0.1:1@evil.example" }));
});

test("refuses provider-specific continuation IDs and oversized bodies", async (context) => {
  const { calls, send } = await fixture(context, { maxBytes: 200 });
  assert.equal((await send({ model: "gpt-test", previous_response_id: "other-provider-id" })).status, 422);
  assert.equal((await send({ model: "gpt-test", input: "x".repeat(300) })).status, 413);
  assert.equal(calls.length, 0);
});

test("accepts compressed Codex requests without forwarding encoding headers", async (context) => {
  const { base, calls } = await fixture(context);
  const compression = [["gzip", zlib.gzipSync], ["zstd", zlib.zstdCompressSync]].filter(([_name, compress]) => compress);
  for (const [encoding, compress] of compression) {
    const response = await fetch(base + "/responses", { method: "POST",
      headers: { authorization: "Bearer fake-token", "content-encoding": encoding },
      body: compress(Buffer.from(JSON.stringify({ model: "gpt-test", input: "hello" }))) });
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.equal(calls.length, compression.length);
  assert.ok(calls.every((call) => call.headers["content-encoding"] === undefined));
});

test("limits decompressed data and rejects unsupported encodings", async (context) => {
  const { base, calls } = await fixture(context, { maxBytes: 200 });
  for (const [encoding, body, status] of [
    ["gzip", zlib.gzipSync(Buffer.from("x".repeat(500))), 413],
    ["constructor", Buffer.from("{}"), 415],
  ]) {
    const response = await fetch(base + "/responses", { method: "POST",
      headers: { authorization: "Bearer fake-token", "content-encoding": encoding }, body });
    assert.equal(response.status, status);
  }
  assert.equal(calls.length, 0);
});

test("rejects opaque references and a missing summary model without discarding history", async (context) => {
  const { calls, send } = await fixture(context);
  const response = await send({ model: "deepseek-test", input: [{ type: "compaction", encrypted_content: "native-opaque" }] });
  assert.equal(response.status, 422);
  assert.equal(calls.length, 0);
  assert.equal((await send({ model: "deepseek-test", input: [{ type: "item_reference", id: "opaque" }] })).status, 422);
});

test("summarizes compacted context only for that thread and keeps native chats unchanged", async (context) => {
  const forwarded = [];
  let summaries = 0;
  const { send } = await fixture(context, { summaryModel: "gpt-test", fetcher: async (_url, options) => {
    const body = JSON.parse(options.body);
    forwarded.push({ body, headers: options.headers });
    const isSummary = body.instructions?.startsWith("Produce only");
    if (isSummary) summaries++;
    return Response.json({ status: "completed", output: [{ type: "message", role: "assistant", content: [
      { type: "output_text", text: isSummary ? "handoff-" + summaries : "OK" },
    ] }] });
  } });
  const input = [
    { type: "message", role: "developer", content: "project constraints" },
    { type: "compaction", encrypted_content: "opaque-native-history" },
    { type: "message", role: "user", content: "latest request" },
  ];
  for (const thread of ["chat-A", "chat-A", "chat-B"]) {
    const response = await send({ model: "deepseek-test", input, prompt_cache_key: thread }, { "chatgpt-account-id": "account-A" });
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.equal(summaries, 2);
  const go = forwarded.filter((call) => call.body.model === "deepseek-test");
  assert.deepEqual(go.map((call) => call.body.input[1].content[0].text.match(/handoff-\d/)[0]), ["handoff-1", "handoff-1", "handoff-2"]);
  for (const call of go) {
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.headers["chatgpt-account-id"], undefined);
    assert.equal(call.body.input[0].role, "developer");
    assert.equal(call.body.input.at(-1).content, "latest request");
    assert.doesNotMatch(JSON.stringify(call.body), /opaque-native-history/);
  }
  const summary = forwarded[0];
  assert.equal(summary.headers.authorization, "Bearer fake-native-token");
  assert.equal(summary.headers["chatgpt-account-id"], "account-A");
  assert.equal(summary.body.tools.length, 0);
  assert.equal(summary.body.store, false);
  assert.equal(summary.body.input.some((item) => item.type === "compaction"), true);
  await (await send({ model: "gpt-test", input, prompt_cache_key: "chat-C" })).text();
  assert.equal(summaries, 2);
  assert.deepEqual(forwarded.at(-1).body.input, input);
  assert.equal(input[1].type, "compaction");
});

test("does not reuse a handoff across accounts or forward a failed summary to OpenCode", async (context) => {
  const summaries = [];
  let goCalls = 0;
  const { send } = await fixture(context, { summaryModel: "gpt-test", fetcher: async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.model === "deepseek-test") {
      goCalls++;
      return Response.json({ status: "completed", output: [] });
    }
    summaries.push(options.headers["chatgpt-account-id"]);
    if (options.headers["chatgpt-account-id"] === "fail") return new Response("", { status: 400 });
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "handoff" }] }] });
  } });
  const body = { model: "deepseek-test", prompt_cache_key: "same-thread", input: [{ type: "compaction", encrypted_content: "opaque" }] };
  for (const account of ["A", "B", "fail"]) {
    const response = await send(body, { "chatgpt-account-id": account });
    assert.equal(response.status, account === "fail" ? 502 : 200);
    await response.text();
  }
  assert.deepEqual(summaries, ["A", "B", "fail"]);
  assert.equal(goCalls, 2);
});

test("requires a completed summary and handles split SSE without sharing concurrent threads", async (context) => {
  const outputs = [];
  const { send } = await fixture(context, { summaryModel: "gpt-test", fetcher: async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.model === "deepseek-test") {
      outputs.push(body.input[0].content[0].text);
      return Response.json({ status: "completed", output: [] });
    }
    const id = body.input.find((item) => item.type === "compaction").encrypted_content;
    await new Promise((resolve) => setTimeout(resolve, id === "A" ? 10 : 0));
    const status = id === "incomplete" ? "incomplete" : "completed";
    const event = "data: " + JSON.stringify({ type: "response.completed", response: { status, output: [
      { type: "message", content: [{ type: "output_text", text: "summary-" + id }] },
    ] } }) + "\n\n";
    return new Response(new ReadableStream({ start(controller) {
      const bytes = new TextEncoder().encode(event);
      for (const value of bytes) controller.enqueue(new Uint8Array([value]));
      controller.close();
    } }));
  } });
  const sendThread = async (thread) => {
    const response = await send({ model: "deepseek-test", prompt_cache_key: thread,
      input: [{ type: "compaction", encrypted_content: thread }] });
    await response.text();
    return response.status;
  };
  assert.deepEqual(await Promise.all([sendThread("A"), sendThread("B")]), [200, 200]);
  assert.equal(outputs.filter((text) => text.includes("summary-A")).length, 1);
  assert.equal(outputs.filter((text) => text.includes("summary-B")).length, 1);
  assert.equal(await sendThread("incomplete"), 502);
  assert.equal(outputs.length, 2);
});

test("times out an unresponsive upstream", async (context) => {
  const { send } = await fixture(context, { timeoutMs: 20,
    fetcher: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  const response = await send({ model: "gpt-test" });
  assert.equal(response.status, 504);
});

test("records per-stage timings and cache outcomes without logging credentials or conversation", async (context) => {
  const metrics = [];
  const { send } = await fixture(context, { summaryModel: "gpt-test", onMetric: (metric) => metrics.push(metric),
    fetcher: async () => Response.json({ status: "completed", output: [
      { type: "message", content: [{ type: "output_text", text: "handoff" }] },
    ] }) });
  const body = { model: "deepseek-test", prompt_cache_key: "secret-thread", input: [
    { type: "compaction", encrypted_content: "secret-history" }, { role: "user", content: "private text" },
  ] };
  for (let count = 0; count < 2; count++) await (await send(body)).text();
  assert.deepEqual(metrics.map((metric) => metric.summary_cache), ["miss", "hit"]);
  for (const metric of metrics) {
    for (const name of ["summary_ms", "upstream_headers_ms", "first_upstream_byte_ms", "upstream_stream_ms", "total_ms"]) {
      assert.equal(typeof metric[name], "number", name);
      assert.ok(metric[name] >= 0, name);
    }
    assert.equal(metric.status, 200);
    assert.equal(metric.outcome, "complete");
    assert.ok(metric.received_bytes > 0 && metric.forwarded_bytes > 0 && metric.response_bytes > 0);
    assert.ok(metric.tools_count >= 0 && metric.tools_bytes >= 0 && metric.instructions_bytes >= 0);
    assert.ok(metric.estimated_input_tokens > 0 && metric.forwarded_tools_bytes >= 0);
    assert.doesNotMatch(JSON.stringify(metric), /secret-|private text|fake-native-token|authorization/);
  }
});

test("rejects an OpenCode request over the input budget before contacting upstream", async (context) => {
  const metrics = [];
  const { calls, send } = await fixture(context, { opencodeSoftLimitTokens: 0, opencodeHardLimitTokens: 1,
    onMetric: (metric) => metrics.push(metric) });
  const response = await send({ model: "deepseek-test", input: "hello" });
  assert.equal(response.status, 413);
  assert.match(await response.text(), /input_budget_exceeded|上限/);
  assert.equal(calls.length, 0);
  assert.equal(metrics[0].stage, "budget_rejected");
  assert.equal(metrics[0].status, 413);
});

test("records a soft budget warning while allowing the request", async (context) => {
  const metrics = [];
  const { calls, send } = await fixture(context, { opencodeSoftLimitTokens: 1, opencodeHardLimitTokens: 0,
    onMetric: (metric) => metrics.push(metric) });
  const response = await send({ model: "deepseek-test", input: "hello" });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(calls.length, 1);
  assert.equal(metrics[0].budget_warning, true);
});

test("estimates token density for ASCII and non-ASCII input", () => {
  assert.ok(estimateInputTokens("a".repeat(400)) <= 120);
  assert.ok(estimateInputTokens("あ".repeat(100)) >= 100);
  assert.ok(estimateInputTokens("あ".repeat(100)) > estimateInputTokens("a".repeat(100)));
});

test("recovers an over-budget history once, preserving schemas, current work and auth isolation", async (context) => {
  const forwarded = [];
  const metrics = [];
  const { send } = await fixture(context, { summaryModel: "gpt-test", opencodeSoftLimitTokens: 1000,
    opencodeHardLimitTokens: 1400, onMetric: (metric) => metrics.push(metric), fetcher: async (url, options) => {
      const body = JSON.parse(options.body);
      forwarded.push({ url, body, headers: options.headers });
      return Response.json({ status: "completed", output: [{ type: "message", content: [
        { type: "output_text", text: body.instructions?.startsWith("Produce only") ? "Old decisions and work preserved." : "OK" },
      ] }] });
    } });
  const tools = [{ type: "function", name: "edit", parameters: { type: "object", properties: { text: { type: "string" } } } }];
  const input = [
    { role: "developer", content: "Keep project constraints" },
    { role: "user", content: "old " + "x".repeat(10000) },
    { role: "assistant", content: "old result" },
    { role: "user", content: "recent request" },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "edit", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "OK" },
    { role: "user", content: "latest request" },
  ];
  const original = structuredClone(input);
  for (let turn = 0; turn < 2; turn++) {
    const response = await send({ model: "deepseek-test", input, tools, prompt_cache_key: "chat-budget" });
    assert.equal(response.status, 200);
    await response.text();
  }
  const summaries = forwarded.filter((call) => call.body.model === "gpt-test");
  const downstream = forwarded.filter((call) => call.body.model === "deepseek-test");
  assert.equal(summaries.length, 1, "same completed prefix should reuse its summary");
  assert.equal(summaries[0].headers.authorization, "Bearer fake-native-token");
  assert.deepEqual(summaries[0].body.tools, []);
  assert.equal(summaries[0].body.input.some((item) => item.content === "latest request"), false);
  assert.equal(downstream.length, 2);
  for (const call of downstream) {
    assert.deepEqual(call.body.tools, tools);
    assert.deepEqual(call.body.input.slice(-4), input.slice(-4));
    assert.deepEqual(call.body.input[0], input[0]);
    assert.equal(call.headers.authorization, undefined);
    assert.ok(estimateInputTokens(JSON.stringify(call.body)) <= 1400);
  }
  assert.deepEqual(input, original);
  assert.equal(metrics[0].budget_recovered, true);
  assert.equal(metrics[1].budget_summary_cache, "hit");
  assert.doesNotMatch(JSON.stringify(metrics), /fake-native-token|latest request|Old decisions|Keep project/);
});

test("does not summarize in-budget or native requests, or when recovery is disabled or cannot help", async (context) => {
  const input = [{ role: "user", content: "x".repeat(10000) }, { role: "assistant", content: "old" }, { role: "user", content: "latest" }];
  for (const scenario of ["within", "native", "disabled", "tools", "latest", "pending", "model", "auth"]) {
    const options = { summaryModel: "gpt-test", opencodeSoftLimitTokens: 1000, opencodeHardLimitTokens: 1400 };
    if (scenario === "disabled") options.autoBudgetHandoff = false;
    if (scenario === "model") options.summaryModel = "missing";
    const { calls, send } = await fixture(context, options);
    const body = { model: scenario === "native" ? "gpt-test" : "deepseek-test", input: structuredClone(input) };
    if (scenario === "within") body.input = [{ role: "user", content: "hello" }];
    if (scenario === "tools") body.tools = [{ type: "function", name: "tool", description: "x".repeat(10000) }];
    if (scenario === "latest") body.input.at(-1).content = "x".repeat(10000);
    if (scenario === "pending") body.input.splice(2, 0, { type: "function_call", call_id: "pending", name: "tool", arguments: "{}" });
    const response = await send(body, scenario === "auth" ? { authorization: "" } : {});
    assert.equal(response.status, ["within", "native"].includes(scenario) ? 200 : scenario === "auth" ? 401 : 413, scenario);
    await response.text();
    assert.equal(calls.length, ["within", "native"].includes(scenario) ? 1 : 0, scenario);
  }
});

test("summarizes at the soft threshold before reaching the hard limit", async (context) => {
  const metrics = [];
  let summaries = 0;
  const { send } = await fixture(context, { summaryModel: "gpt-test", opencodeSoftLimitTokens: 500,
    opencodeHardLimitTokens: 2000, onMetric: (metric) => metrics.push(metric), fetcher: async (_url, options) => {
      if (JSON.parse(options.body).model === "gpt-test") summaries++;
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "summary" }] }] });
    } });
  const response = await send({ model: "deepseek-test", input: [
    { role: "user", content: "x".repeat(4000) }, { role: "user", content: "latest" },
  ] });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(summaries, 1);
  assert.ok(metrics[0].budget_initial_tokens > 500 && metrics[0].budget_initial_tokens < 2000);
  assert.ok(metrics[0].estimated_input_tokens < 500);
});

test("a failed or insufficient budget summary never forwards oversized context or retries endlessly", async (context) => {
  for (const kind of ["http-error", "incomplete", "still-large"]) {
    let calls = 0;
    const { send } = await fixture(context, { summaryModel: "gpt-test", opencodeSoftLimitTokens: 1000,
      opencodeHardLimitTokens: 1400, fetcher: async () => {
        calls++;
        if (kind === "http-error") return new Response("failed", { status: 503 });
        return Response.json({ status: kind === "incomplete" ? "incomplete" : "completed", output: [
          { type: "message", content: [{ type: "output_text", text: "x".repeat(10000) }] },
        ] });
      } });
    const input = [{ role: "user", content: "x".repeat(10000) }, { role: "user", content: "latest" }];
    const response = await send({ model: "deepseek-test", input });
    assert.equal(response.status, kind === "still-large" ? 413 : 502, kind);
    await response.text();
    assert.equal(calls, 1);
    assert.equal(input[0].content.length, 10000);
  }
});

test("records received bytes for rejected and empty input", async (context) => {
  const metrics = [];
  const { send, base } = await fixture(context, { maxBytes: 200, onMetric: (metric) => metrics.push(metric) });
  const oversized = await send({ model: "gpt-test", input: "x".repeat(300) });
  await oversized.text();
  assert.equal(oversized.status, 413);
  assert.ok(metrics[0].received_bytes > 200);
  const empty = await fetch(base + "/responses", { method: "POST", headers: { authorization: "Bearer test" }, body: "" });
  await empty.text();
  assert.equal(empty.status, 400);
  assert.equal(metrics[1].received_bytes, 0);
});

test("streams first output before completion even with metrics enabled", async (context) => {
  let controller;
  const metrics = [];
  const { send } = await fixture(context, { onMetric: (metric) => metrics.push(metric),
    fetcher: async () => new Response(new ReadableStream({ start(value) {
      controller = value;
      value.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"early"}\n\n'));
    } }), { headers: { "content-type": "text/event-stream" } }) });
  const response = await send({ model: "deepseek-test", stream: true });
  const reader = response.body.getReader();
  try {
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /early/);
    assert.equal(metrics.length, 0);
  } finally {
    controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n'));
    controller.close();
    while (!(await reader.read()).done) {}
  }
  assert.equal(metrics[0].outcome, "complete");
});
