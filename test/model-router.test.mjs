import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import * as zlib from "node:zlib";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogRoutes, createRouter, estimateInputTokens, readOpenCodeKey, routedBody } from "../src/model-router.mjs";

const catalog = { models: [
  { slug: "gpt-test", router_provider: "openai" },
  { slug: "opencode/deepseek-test", router_provider: "opencode", router_model: "deepseek-test" },
  { slug: "opencode/gpt-test", router_provider: "opencode", router_model: "gpt-test" },
  { slug: "opencode/direct-test", router_provider: "opencode", router_model: "direct-test", router_transport: "responses" },
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
    const body = JSON.parse(text);
    calls.push({ provider, headers: request.headers, body, path: request.url });
    if (options.upstreamResponse && await options.upstreamResponse({ provider, request, response, body })) return;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`event: response.created\ndata: ${JSON.stringify({ provider })}\n\n`);
    response.end("event: response.completed\ndata: {}\n\n");
  });
  const native = upstream("openai");
  const bridge = upstream("opencode");
  const nativeBase = await listen(native);
  const bridgeBase = await listen(bridge);
  const router = createRouter({ catalog, historyMode: "openai", nativeBase, bridgeBase, openCodeBase: bridgeBase,
    openCodeKey: () => "fake-opencode-key", allowTestOrigins: true, allowDirectResponses: true,
    authenticate: () => true, bridgeKey: () => "test-internal-key", ...options });
  const base = await listen(router);
  context.after(async () => { await close(router); await close(native); await close(bridge); });
  const send = (body, headers = {}) => fetch(base + "/responses", {
    method: "POST", headers: { authorization: "Bearer fake-native-token", "content-type": "application/json",
      "x-codex-bridge-direct": "1", ...headers },
    body: JSON.stringify(body),
  });
  return { calls, base, send };
}

test("remote compaction trigger uses the native model instead of Chat conversion", async context => {
  const originalInput = [{ role: "user", content: "continue" }, { type: "compaction_trigger" }];
  const { calls, send } = await fixture(context, { summaryModel: "gpt-test",
    upstreamResponse: async ({ provider, response, body }) => {
      if (provider !== "openai" || !body.input.some(item => item.type === "compaction_trigger")) return false;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: response.output_item.done\ndata: " + JSON.stringify({ type: "response.output_item.done",
        output_index: 0, item: { id: "cmp_test", type: "compaction", encrypted_content: "opaque-summary" } }) + "\n\n");
      response.end("event: response.completed\ndata: " + JSON.stringify({ type: "response.completed",
        response: { id: "resp_compact", status: "completed", output: [] } }) + "\n\n");
      return true;
    } });
  const response = await send({ model: "opencode/deepseek-test", stream: true, input: originalInput });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.match(text, /opaque-summary/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "openai");
  assert.equal(calls[0].path, "/v1/responses");
  assert.equal(calls[0].body.model, "gpt-test");
  assert.deepEqual(calls[0].body.input, originalInput);
});

test("remote compaction fails safely without a native summary model", async context => {
  const { calls, send } = await fixture(context);
  const response = await send({ model: "opencode/deepseek-test",
    input: [{ role: "user", content: "continue" }, { type: "compaction_trigger" }] });
  assert.equal(response.status, 422);
  assert.match(await response.text(), /remote_compaction_model_required/);
  assert.equal(calls.length, 0);
});

test("direct authentication uses API keys only and never extracts login credentials", (context) => {
  const home = mkdtempSync(join(tmpdir(), "direct-auth-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, ".local/share/opencode");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "opencode.db"), "DO NOT READ LOGIN CREDENTIALS");
  writeFileSync(join(directory, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "test-api" } }), { mode: 0o600 });
  const options = { home, environment: {} };
  assert.equal(readOpenCodeKey(options), "test-api");
  assert.equal(readOpenCodeKey({ ...options, environment: { OPENCODE_API_KEY: "test-override" } }), "test-override");
  writeFileSync(join(directory, "auth.json"), "{}");
  assert.equal(readOpenCodeKey(options), null);
});

test("official Responses bypasses conversion, GPT summaries and heuristic budget rejection", async (context) => {
  const { calls, send, base } = await fixture(context, { opencodeSoftLimitTokens: 1, opencodeHardLimitTokens: 1 });
  const body = { model: "opencode/direct-test", prompt_cache_key: "thread-direct", instructions: "constraints",
    reasoning: { effort: "high" }, previous_response_id: "resp_previous", stream: true,
    tools: [{ type: "custom", name: "exec", format: { type: "text" } }], input: [
      { type: "compaction", encrypted_content: "provider-owned-history" },
      { type: "reasoning", encrypted_content: "native-reasoning", summary: [] },
      { type: "custom_tool_call", call_id: "call_tool", name: "exec", input: "read file" },
      { type: "custom_tool_call_output", call_id: "call_tool", output: "x".repeat(10000) },
      { role: "user", content: "continue" },
    ] };
  const response = await send(body, { "chatgpt-account-id": "private-account", session_id: "session-direct" });
  assert.equal(response.status, 200, await response.text());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "opencode");
  assert.deepEqual(calls[0].body, { ...body, model: "direct-test" });
  assert.equal(calls[0].headers.authorization, "Bearer fake-opencode-key");
  assert.equal(calls[0].headers["chatgpt-account-id"], undefined);
  assert.equal(calls[0].headers.session_id, "session-direct");
  assert.equal(calls[0].headers["x-opencode-session"], "session-direct");
  const compact = await fetch(base + "/responses/compact", { method: "POST",
    headers: { authorization: "Bearer native-token", "content-type": "application/json", "x-codex-bridge-direct": "1" }, body: JSON.stringify(body) });
  assert.equal(compact.status, 200, await compact.text());
  assert.equal(calls[1].path, "/v1/responses/compact");
  assert.deepEqual(calls[1].body, { ...body, model: "direct-test" });
});

test("direct Responses fails closed without OpenCode credentials and never falls back to GPT", async (context) => {
  const { calls, send } = await fixture(context, { openCodeKey: () => null });
  const response = await send({ model: "direct-test", input: [{ type: "compaction", encrypted_content: "opaque" }] });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /opencode_auth_required/);
  assert.equal(calls.length, 0);
});

test("existing sessions without the direct marker keep their legacy transport", async (context) => {
  const { calls, send } = await fixture(context);
  const response = await send({ model: "direct-test", tools: [{ type: "custom", name: "exec" }] }, { "x-codex-bridge-direct": "" });
  assert.equal(response.status, 200, await response.text());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(calls[0].body.tools[0].type, "function");
});

test("direct Responses preserves native custom events, normalizes phases, and never falls back", async (context) => {
  const event = 'data: {"type":"response.output_item.added","item":{"type":"message","id":"msg_1","role":"assistant","content":[]}}\n\n'
    + 'data: {"type":"response.output_item.done","item":{"type":"custom_tool_call","id":"ctc_native","call_id":"native","name":"exec","input":"read file"}}\n\n';
  for (const status of [200, 400, 429, 302]) {
    let count = 0;
    const { send } = await fixture(context, { fetcher: async (_url, options) => {
      count++;
      assert.equal(options.headers.authorization, "Bearer fake-opencode-key");
      assert.equal(options.redirect, "manual");
      return new Response(status === 200 ? event : "upstream-error", { status,
        headers: { "content-type": "text/event-stream", "retry-after": "5", location: "https://example.org/" } });
    } });
    const response = await send({ model: "direct-test", tools: [{ type: "custom", name: "exec" }] });
    assert.equal(response.status, status === 302 ? 502 : status);
    const text = await response.text();
    if (status === 200) {
      assert.match(text, /"type":"message"/);
      assert.match(text, /"phase":"final_answer"/);
      assert.match(text, /"type":"custom_tool_call"/);
      assert.doesNotMatch(text, /"type":"function_call"/);
    }
    if (status === 400 || status === 429) {
      assert.equal(text, "upstream-error");
      assert.equal(response.headers.get("retry-after"), "5");
    }
    assert.equal(count, 1);
  }
  assert.throws(() => createRouter({ catalog, historyMode: "openai", openCodeBase: "https://example.org/v1" }), /公式origin/);
});

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
  const { calls, base, send } = await fixture(context, { summaryModel: "gpt-test" });
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
  const unauthorized = await send({ model: "gpt-test" }, { authorization: "" });
  assert.equal(unauthorized.status, 401);
  assert.match(await unauthorized.text(), /codex --profile direct/);
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
  assert.throws(() => createRouter({ catalog, historyMode: "openai", nativeBase: "https://example.com" }));
  assert.throws(() => createRouter({ catalog, historyMode: "openai", bridgeBase: "https://example.com" }));
  assert.throws(() => createRouter({ catalog, historyMode: "openai", bridgeBase: "http://127.0.0.1:1@evil.example" }));
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
  const { base, calls } = await fixture(context, { maxBytes: 200, maxRequestBytes: 200 });
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

test("byte-heavy image history reaches summarization before the forwarding limit, for plain/gzip/zstd requests", async (context) => {
  const forwarded = [];
  const metrics = [];
  const { base } = await fixture(context, { maxBytes: 5000, maxRequestBytes: 20000, summaryModel: "gpt-test",
    opencodeSoftLimitTokens: 100000, opencodeHardLimitTokens: 200000, onMetric: m => metrics.push(m),
    fetcher: async (url, options) => {
      const body = JSON.parse(options.body); forwarded.push({ url, body, headers: options.headers });
      return Response.json({ status: "completed", output: [{ type: "message", content: [
        { type: "output_text", text: "Completed image work and next steps." },
      ] }] });
    } });
  const latest = [ { role: "user", content: "current work" },
    { type: "function_call", call_id: "pending", name: "edit", arguments: "{}" },
    { role: "user", content: "latest request" } ];
  const input = [{ role: "developer", content: "constraints" },
    { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64," + "A".repeat(9000) }] },
    { role: "assistant", content: "old result" }, ...latest];
  const body = { model: "deepseek-test", input, tools: [{ type: "function", name: "edit", parameters: { type: "object" } }] };
  assert.ok(estimateInputTokens(body) < 100000, "byte recovery must not depend on the token trigger");
  const original = JSON.stringify(body);
  for (const [encoding, compress] of [["identity", x => x], ["gzip", zlib.gzipSync], ["zstd", zlib.zstdCompressSync]].filter(([, fn]) => fn)) {
    const response = await fetch(base + "/responses", { method: "POST", headers: {
      authorization: "Bearer fake-native-token", "content-encoding": encoding,
    }, body: compress(Buffer.from(original)) });
    assert.equal(response.status, 200, await response.text());
  }
  const summaries = forwarded.filter(c => c.body.model === "gpt-test");
  const downstream = forwarded.filter(c => c.body.model === "deepseek-test");
  assert.equal(summaries.length, downstream.length);
  assert.ok(summaries.length >= 2);
  for (const c of summaries) { assert.deepEqual(c.body.tools, []); assert.ok(c.body.input.some(i => Array.isArray(i.content) && i.content.some(p => p.type === "input_image"))); }
  for (const c of downstream) {
    assert.ok(Buffer.byteLength(JSON.stringify(c.body)) <= 5000);
    assert.deepEqual(c.body.input.slice(-3), latest);
    assert.deepEqual(c.body.input[0], input[0]); assert.deepEqual(c.body.tools, body.tools);
    assert.equal(c.headers.authorization, undefined);
  }
  assert.ok(metrics.every(m => m.budget_initial_bytes > 5000 && m.budget_recovered));
  assert.equal(JSON.stringify(body), original);
});

test("default limits recover a compressed image history larger than 32 MiB", async context => {
  const metrics = []; let summaryCalls = 0; let answerCalls = 0;
  const { base } = await fixture(context, { summaryModel: "gpt-test", onMetric: m => metrics.push(m),
    fetcher: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === "gpt-test") {
        summaryCalls++; assert.deepEqual(body.tools, []);
      } else { answerCalls++; assert.ok(Buffer.byteLength(init.body) < 32 * 1024 * 1024); }
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Image created; continue the current work." }] }] });
    } });
  const body = { model: "deepseek-test", input: [
    { role: "user", content: "old work" },
    { type: "function_call", call_id: "image", name: "imagegen", arguments: "{}" },
    { type: "function_call_output", call_id: "image", output: [{ type: "input_image", image_url: "data:image/png;base64," + "A".repeat(33 * 1024 * 1024) }] },
    { role: "user", content: "recent" }, { role: "user", content: "latest" },
  ] };
  const response = await fetch(base + "/responses", { method: "POST", headers: {
    authorization: "Bearer fake-native-token", "content-encoding": "gzip",
  }, body: zlib.gzipSync(Buffer.from(JSON.stringify(body))) });
  assert.equal(response.status, 200, await response.text());
  assert.equal(summaryCalls, 1); assert.equal(answerCalls, 1);
  assert.ok(metrics[0].received_bytes < 32 * 1024 * 1024);
  assert.ok(metrics[0].decoded_bytes > 32 * 1024 * 1024);
  assert.ok(metrics[0].budget_initial_bytes > 32 * 1024 * 1024);
  assert.equal(metrics[0].budget_recovered, true);
});

test("byte recovery keeps protected images, pending tools, schemas and native routing bounded", async context => {
  for (const scenario of ["latest", "pending", "tools", "disabled", "native", "insufficient", "compacted"]) {
    const sent = []; const metrics = [];
    const { send } = await fixture(context, { maxBytes: 5000, maxRequestBytes: 20000, summaryModel: "gpt-test",
      autoBudgetHandoff: scenario !== "disabled", onMetric: m => metrics.push(m),
      fetcher: async (_url, init) => {
        const body = JSON.parse(init.body); sent.push(body);
        return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text",
          text: scenario === "insufficient" ? "x".repeat(4800) : "Summary" }] }] });
      } });
    const image = [{ type: "input_image", image_url: "data:image/png;base64," + "A".repeat(9000) }];
    const body = { model: scenario === "native" ? "gpt-test" : "deepseek-test", input: [
      { role: "user", content: image }, { role: "assistant", content: "old result" },
      { role: "user", content: "recent" }, { role: "user", content: "latest" },
    ] };
    if (scenario === "latest") body.input.at(-1).content = image;
    if (scenario === "pending") body.input.splice(1, 0, { type: "function_call", call_id: "pending", name: "edit", arguments: "{}" });
    if (scenario === "tools") { body.input[0].content = "old"; body.tools = [{ type: "function", name: "tool", description: "x".repeat(9000) }]; }
    if (scenario === "compacted") body.input.unshift({ type: "compaction", encrypted_content: "native-opaque" });
    const original = structuredClone(body);
    const response = await send(body);
    assert.equal(response.status, scenario === "compacted" ? 200 : 413, scenario + ": " + await response.text());
    assert.deepEqual(body, original);
    const answers = sent.filter(b => b.model === "deepseek-test");
    assert.equal(answers.length, scenario === "compacted" ? 1 : 0, scenario);
    assert.equal(sent.filter(b => b.instructions?.startsWith("Produce only")).length,
      ["compacted", "insufficient"].includes(scenario) ? 1 : 0, scenario);
    if (scenario === "compacted") { assert.equal(metrics[0].budget_compaction_extended, true); assert.ok(Buffer.byteLength(JSON.stringify(answers[0])) < 5000); }
  }
});

test("wire and decoded request limits remain finite with inclusive boundaries", async context => {
  const metrics = [];
  const { base, calls } = await fixture(context, { maxBytes: 1000, maxRequestBytes: 1000, onMetric: m => metrics.push(m) });
  const stub = JSON.stringify({ model: "gpt-test", input: "" });
  const exact = Buffer.from(JSON.stringify({ model: "gpt-test", input: "a".repeat(1000 - Buffer.byteLength(stub)) }));
  assert.equal(exact.length, 1000);
  for (const [encoding, compress] of [["identity", x => x], ["gzip", zlib.gzipSync], ["br", zlib.brotliCompressSync], ["zstd", zlib.zstdCompressSync]].filter(([, fn]) => fn)) {
    const accepted = await fetch(base + "/responses", { method: "POST", headers: { authorization: "Bearer test", "content-encoding": encoding }, body: compress(exact) });
    assert.equal(accepted.status, 200); await accepted.text();
    const rejected = await fetch(base + "/responses", { method: "POST", headers: { authorization: "Bearer test", "content-encoding": encoding }, body: compress(Buffer.concat([exact, Buffer.from(" ")])) });
    assert.equal(rejected.status, 413); await rejected.text();
  }
  assert.ok(calls.length >= 3);
  assert.ok(metrics.filter(m => m.status === 413).every(m => ["wire_bytes", "decoded_bytes"].includes(m.input_limit_reason)));
  for (const maxRequestBytes of [0, Infinity, NaN, 999]) assert.throws(() => createRouter({ catalog, historyMode: "openai", maxBytes: 1000, maxRequestBytes }));
});

test("byte recovery can summarize completed image tools within one turn without losing steering or pending calls", async context => {
  for (const compacted of [false, true]) {
    const sent = []; const metrics = [];
    const { send } = await fixture(context, { maxBytes: 5000, maxRequestBytes: 20000, summaryModel: "gpt-test",
      onMetric: m => metrics.push(m), fetcher: async (_url, init) => {
        sent.push(JSON.parse(init.body));
        return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Previous images created." }] }] });
      } });
    const current = [{ type: "function_call", call_id: "pending", name: "edit", arguments: "{}" }, { role: "user", content: "latest steering" }];
    const body = { model: "deepseek-test", input: [
      ...(compacted ? [{ type: "compaction", encrypted_content: "native-opaque" }] : []),
      { role: "developer", content: "constraints" }, { role: "user", content: "original request" },
      { type: "function_call", call_id: "image", name: "imagegen", arguments: "{}" },
      { type: "function_call_output", call_id: "image", output: [{ type: "input_image", image_url: "data:image/png;base64," + "A".repeat(9000) }] }, ...current,
    ] };
    const response = await send(body);
    assert.equal(response.status, 200, await response.text());
    assert.equal(sent.filter(b => b.model === "gpt-test").length, 1);
    const answer = sent.find(b => b.model === "deepseek-test");
    assert.deepEqual(answer.input.slice(-2), current);
    assert.ok(answer.input.some(i => i.role === "user" && i.content === "original request"));
    assert.ok(answer.input.some(i => i.role === "developer" && i.content === "constraints"));
    assert.equal(metrics[0].budget_intra_turn, true);
    assert.ok(Buffer.byteLength(JSON.stringify(answer)) < 5000);
  }
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
  assert.equal(metrics[1].budget_prefix_cache, "hit");
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
    assert.equal(calls, kind === "http-error" ? 2 : 1);
    assert.equal(input[0].content.length, 10000);
  }
});

test("extends the original compaction handoff to older completed turns instead of summarizing twice", async (context) => {
  let summaries = 0;
  const metrics = [];
  const { send } = await fixture(context, { summaryModel: "gpt-test", opencodeSoftLimitTokens: 500,
    opencodeHardLimitTokens: 1000, onMetric: (metric) => metrics.push(metric), fetcher: async (_url, options) => {
      if (JSON.parse(options.body).model === "gpt-test") summaries++;
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "first summary" }] }] });
    } });
  const response = await send({ model: "deepseek-test", input: [
    { type: "compaction", encrypted_content: "opaque" }, { role: "user", content: "x".repeat(10000) },
    { role: "user", content: "recent" }, { role: "user", content: "latest" },
  ] });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(summaries, 1);
  assert.equal(metrics[0].budget_summary_cache, undefined);
  assert.equal(metrics[0].budget_compaction_extended, true);
  assert.equal(metrics[0].budget_recovered, true);
});

test("recovers completed tool history within one turn, including after native compaction", async (context) => {
  for (const compacted of [false, true]) {
    const forwarded = [];
    const { send } = await fixture(context, { summaryModel: "gpt-test", opencodeSoftLimitTokens: 600,
      opencodeHardLimitTokens: 1000, fetcher: async (_url, options) => {
        forwarded.push(JSON.parse(options.body));
        return Response.json({ status: "completed", output: [{ type: "message", content: [
          { type: "output_text", text: "Completed investigation, continue testing." },
        ] }] });
      } });
    const input = [
      ...(compacted ? [{ type: "compaction", encrypted_content: "opaque" }] : []),
      { role: "developer", content: "Do not deploy" },
      { role: "user", content: "Investigate and fix the failure" },
      { type: "function_call", call_id: "first", name: "read", arguments: "{}" },
      { role: "user", content: "Keep my local changes" },
      { type: "function_call_output", call_id: "first", output: "x".repeat(10000) },
      { type: "custom_tool_call", call_id: "second", name: "edit", input: "patch" },
      { type: "custom_tool_call_output", call_id: "second", output: "done" },
      { type: "function_call", call_id: "pending", name: "test", arguments: "{}" },
    ];
    const original = structuredClone(input);
    const tools = [{ type: "function", name: "read", parameters: { type: "object" } }];
    for (let request = 0; request < 2; request++) {
      const response = await send({ model: "deepseek-test", input, tools, prompt_cache_key: "long-turn" });
      assert.equal(response.status, 200, await response.text());
    }
    assert.equal(forwarded.filter((body) => body.model === "gpt-test").length, 1);
    for (const body of forwarded.filter((body) => body.model === "deepseek-test")) {
      assert.deepEqual(body.tools, tools);
      assert.deepEqual(body.input.filter((item) => item.role === "developer"), input.filter((item) => item.role === "developer"));
      for (const user of input.filter((item) => item.role === "user")) assert.ok(body.input.some((item) => item.content === user.content));
      const retained = routedBody({ input: input.slice(-3) }, { provider: "opencode", model: "deepseek-test" }, 100000).input;
      assert.deepEqual(body.input.slice(-3), JSON.parse(JSON.stringify(retained)));
      assert.ok(!body.input.some((item) => item.call_id === "first" || item.type === "compaction"));
      assert.ok(estimateInputTokens(body) < 1000);
    }
    assert.deepEqual(input, original);
  }
});

test("records reversed soft/hard limits while still recovering at the hard threshold", async (context) => {
  const metrics = [];
  let summaries = 0;
  const { send } = await fixture(context, { summaryModel: "gpt-test", opencodeSoftLimitTokens: 5000,
    opencodeHardLimitTokens: 1000, onMetric: (metric) => metrics.push(metric), fetcher: async (_url, options) => {
      if (JSON.parse(options.body).model === "gpt-test") summaries++;
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "summary" }] }] });
    } });
  const response = await send({ model: "deepseek-test", input: [{ role: "user", content: "x".repeat(10000) }, { role: "user", content: "latest" }] });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(summaries, 1);
  assert.equal(metrics[0].budget_limit_clamped, true);
  assert.equal(metrics[0].budget_recovered, true);
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

// Exercise the production default against every bundled model, including old direct markers.
test("all OpenCode models share history handoff after switching or resuming", async (context) => {
  const models = JSON.parse(readFileSync(new URL("../src/models.json", import.meta.url))).models;
  const allCatalog = { models: [catalog.models[0], ...models.map(({ id }) => ({
    slug: "opencode/" + id, router_provider: "opencode", router_model: id, router_transport: "responses",
  }))] };
  const calls = [];
  const input = [{ type: "compaction", encrypted_content: "saved-native-history" },
    { role: "user", content: "resumed request" },
    { type: "custom_tool_call", id: "ctc_probe", call_id: "probe", name: "exec", input: "read file" },
    { type: "custom_tool_call_output", call_id: "probe", output: "saved tool result" }];
  const before = structuredClone(input);
  const { send, base } = await fixture(context, { catalog: allCatalog, allowDirectResponses: false,
    summaryModel: "gpt-test", fetcher: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ body, headers: options.headers });
      return Response.json({ status: "completed", output: [{ type: "message", role: "assistant",
        content: [{ type: "output_text", text: "prior requirements and next actions" }] }] });
    } });
  const health = await (await fetch(base.replace(/\/v1$/, "") + "/health")).json();
  assert.equal(health.history_transport, "chat");
  assert.deepEqual(health.direct_models, []);
  for (const { id } of models) {
    const start = calls.length;
    const response = await send({ model: "opencode/" + id, input, prompt_cache_key: "resumed-" + id,
      tools: [{ type: "custom", name: "exec" }] });
    assert.equal(response.status, 200, id + ": " + await response.text());
    assert.equal(calls.length - start, 2, id);
    const forwarded = calls.at(-1);
    assert.equal(forwarded.body.model, id);
    assert.equal(forwarded.body.prompt_cache_key, "resumed-" + id);
    assert.equal(forwarded.headers.authorization, undefined);
    assert.equal(forwarded.headers["x-codex-bridge-auth"], "test-internal-key");
    assert.equal(forwarded.body.tools[0].type, "function");
    assert.equal(forwarded.body.input.at(-2).call_id, "probe");
    assert.equal(forwarded.body.input.at(-1).output, "saved tool result");
    assert.match(JSON.stringify(forwarded.body.input), /prior requirements and next actions/);
    assert.doesNotMatch(JSON.stringify(forwarded.body.input), /saved-native-history/);
  }
  assert.deepEqual(input, before);
});

test("default history handoff stops every route on summary failure", async (context) => {
  const calls = [];
  const { send } = await fixture(context, { allowDirectResponses: false, summaryModel: "gpt-test",
    fetcher: async (url) => { calls.push(url); return new Response("unavailable", { status: 503 }); } });
  const response = await send({ model: "direct-test", input: [{ type: "compaction", encrypted_content: "saved" }] });
  assert.equal(response.status, 502);
  assert.equal(calls.length, 2);
});

test("image budget counts structured user and parallel tool images without charging Base64 as text", async context => {
  const image = 'data:image/png;base64,' + 'A'.repeat(3 * 1024 * 1024);
  const tools = [{type:'function',name:'view_image',parameters:{type:'object'}}];
  const input = [{role:'user',content:[{type:'input_text',text:'Inspect screenshots'}, {type:'input_image',image_url:image}]},
    {type:'function_call',call_id:'a',name:'view_image',arguments:'{}'},
    {type:'function_call',call_id:'b',name:'view_image',arguments:'{}'},
    {type:'function_call_output',call_id:'a',output:[{type:'input_image',image_url:image}]},
    {type:'function_call_output',call_id:'b',output:[{type:'input_image',image_url:image}]},
    {role:'user',content:'Continue'}];
  const original=structuredClone(input);
  const {send,calls}=await fixture(context,{opencodeHardLimitTokens:100000,opencodeSoftLimitTokens:90000});
  const response=await send({model:'deepseek-test',input,tools});
  assert.equal(response.status,200,await response.text());
  assert.equal(calls.length,1);assert.deepEqual(calls[0].body.input,input);
  assert.deepEqual(input,original);assert.deepEqual(calls[0].body.tools,tools);
  assert.ok(estimateInputTokens({input})>=3*8192);
  assert.equal(estimateInputTokens(JSON.stringify({input})),estimateInputTokens({input}));
});

test("image budget never discounts Base64 in plain text, schemas or malformed image sources",()=>{
  const image='data:image/png;base64,'+'A'.repeat(40000);
  for(const body of [
    {input:[{role:'user',content:image}]},
    {input:[{role:'user',content:[{type:'input_text',text:image}]}]},
    {tools:[{type:'function',name:'f',parameters:{type:'object',description:image}}]},
    {input:[{role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,'+'!'.repeat(40000)}]}]},
  ]) assert.ok(estimateInputTokens(body)>10000);
});

test("image token reservation does not bypass the raw request byte limit", async context=>{
 const {send,calls}=await fixture(context,{maxBytes:2048,opencodeHardLimitTokens:20000});
 const response=await send({model:'deepseek-test',input:[{role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,'+'A'.repeat(3000)}]}]});
 assert.equal(response.status,413);await response.text();assert.equal(calls.length,0);
});

test('summary failure codes and bounded retry metadata reach router diagnostics',async context=>{
 const metrics=[];let calls=0;
 const {send}=await fixture(context,{summaryModel:'gpt-test',onMetric:m=>metrics.push(m),fetcher:async()=>{
  calls++;
  if(calls===1)return Response.json({status:'failed',error:{code:'server_error',message:'PRIVATE_SENTINEL'},output:[]});
  return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:calls===2?'handoff':'answer'}]}]});
 }});
 const response=await send({model:'deepseek-test',input:[{type:'compaction',encrypted_content:'opaque'},{role:'user',content:'latest'}]});
 assert.equal(response.status,200);assert.match(await response.text(),/answer/);
 assert.equal(calls,3);assert.equal(metrics[0].summary_attempts,2);assert.equal(metrics[0].summary_error_code,'server_error');
 assert.equal(metrics[0].summary_upstream_status,200);assert.equal(metrics[0].summary_retrying,false);
 assert.doesNotMatch(JSON.stringify(metrics),/PRIVATE_SENTINEL|opaque/);
});

test('summary permanent error code reaches streamed UI without leaking upstream text',async context=>{
 let calls=0;
 const {send}=await fixture(context,{summaryModel:'gpt-test',handoffStatusDelayMs:0,fetcher:async()=>{
  calls++;return new Response('data: '+JSON.stringify({type:'response.failed',response:{status:'failed',error:{code:'invalid_encrypted_content',message:'PRIVATE_SENTINEL'}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
 }});
 const response=await send({model:'deepseek-test',stream:true,input:[{type:'compaction',encrypted_content:'opaque'}]});
 const text=await response.text();assert.match(text,/invalid_encrypted_content/);assert.doesNotMatch(text,/PRIVATE_SENTINEL/);assert.equal(calls,1);
});

test("only retries known OpenCode availability failures, preserving isolation and metrics", async (context) => {
  const forwarded = [];
  const metrics = [];
  const { send } = await fixture(context, {
    onMetric: (metric) => metrics.push(metric),
    fetcher: async (url, options) => {
      forwarded.push({ url, options });
      if (forwarded.length === 2) return new Response("event: response.completed\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
      return Response.json({ error: { type: "server_error", message: "Upstream request failed: Endpoint is unavailable." } }, { status: 429 });
    },
  });
  const body = { model: "deepseek-test", input: "history", prompt_cache_key: "test-thread" };
  const recovered = await send(body);
  assert.equal(recovered.status, 200);
  await recovered.text();
  assert.equal(forwarded.length, 2);
  assert.equal(forwarded[0].url, forwarded[1].url);
  assert.equal(forwarded[0].options, forwarded[1].options);
  assert.equal(forwarded[1].options.headers.authorization, undefined);
  assert.equal(JSON.parse(forwarded[1].options.body).prompt_cache_key, body.prompt_cache_key);
  const native = await send({ ...body, model: "gpt-test" });
  assert.equal(native.status, 429);
  await native.text();
  assert.equal(forwarded.length, 3);
  await new Promise((done) => setImmediate(done));
  assert.equal(metrics[0].upstream_retries, 1);
  assert.equal(metrics[1].upstream_retries, undefined);
});

test("appended short turns reuse a budget prefix until its growing suffix needs compaction", async context => {
  const calls = [], metrics = [];
  const { send } = await fixture(context, { summaryModel: "gpt-test", opencodeSoftLimitTokens: 1000,
    opencodeHardLimitTokens: 1400, onMetric: metric => metrics.push(metric), fetcher: async (_url, options) => {
      const body = JSON.parse(options.body); calls.push(body);
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text",
        text: body.instructions?.startsWith("Produce only") ? "Old decisions retained." : "OK" }] }] });
    } });
  const input = [{ role: "developer", content: "keep constraints" }, { role: "user", content: "x".repeat(10000) },
    { role: "assistant", content: "done" }, { role: "user", content: "recent" }, { role: "user", content: "latest" }];
  for (let index = 0; index < 6; index++) {
    if (index) input.push({ role: "assistant", content: "answer" }, { role: "user", content: "short followup " + index });
    const response = await send({ model: "deepseek-test", input, prompt_cache_key: "short-turn-thread" });
    assert.equal(response.status, 200); await response.text();
    assert.equal(calls.at(-1).input.at(-1).content, input.at(-1).content);
  }
  assert.equal(calls.filter(call => call.instructions?.startsWith("Produce only")).length, 1);
  assert.equal(metrics.filter(metric => metric.budget_prefix_cache === "hit").length, 5);
  input.push({ role: "assistant", content: "new tool evidence " + "z".repeat(10000) },
    { role: "user", content: "review evidence" }, { role: "assistant", content: "reviewed" }, { role: "user", content: "continue" });
  const response = await send({ model: "deepseek-test", input, prompt_cache_key: "short-turn-thread" });
  assert.equal(response.status, 200); await response.text();
  assert.equal(calls.filter(call => call.instructions?.startsWith("Produce only")).length, 2);
  assert.equal(calls.at(-1).input.at(-1).content, "continue");
});

test("small model context triggers summarization below the global input limit", async context => {
  const calls = [], metrics = [];
  const smallCatalog = { models: catalog.models.map(m => m.router_provider === "opencode" ? { ...m, context_window: 2048 } : m) };
  const { send } = await fixture(context, { catalog: smallCatalog, summaryModel: "gpt-test",
    opencodeSoftLimitTokens: 900000, opencodeHardLimitTokens: 1000000, onMetric: m => metrics.push(m),
    fetcher: async (_url, options) => {
      const body = JSON.parse(options.body); calls.push(body);
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Preserved prior work." }] }] });
    } });
  const input = [{ role: "user", content: "x".repeat(16000) }, { role: "assistant", content: "done" },
    { role: "user", content: "recent" }, { role: "user", content: "latest" }];
  const response = await send({ model: "deepseek-test", input, max_output_tokens: 512, prompt_cache_key: "small-thread" });
  assert.equal(response.status, 200); await response.text();
  assert.equal(calls.filter(c => c.instructions?.startsWith("Produce only")).length, 1);
  assert.ok(estimateInputTokens(JSON.stringify(calls.at(-1))) + 512 <= 2048);
  assert.equal(calls.at(-1).input.at(-1).content, "latest");
  assert.equal(metrics[0].model_context_window, 2048);
});

test("model budgets reserve explicit output, retain global caps and do not rewrite native requests", async context => {
  const customCatalog = { models: catalog.models.map(m => ({ ...m, context_window: 2048 })) };
  for (const scenario of ["protected", "output", "global", "native", "disabled", "missing"]) {
    const metrics = [];
    const opts = { catalog: customCatalog, opencodeSoftLimitTokens: 900000, opencodeHardLimitTokens: 1000000, onMetric: m => metrics.push(m) };
    if (scenario === "global") opts.opencodeHardLimitTokens = 150;
    if (scenario === "disabled") opts.opencodeHardLimitTokens = 0;
    if (scenario === "missing") opts.catalog = catalog;
    const { calls, send } = await fixture(context, opts);
    const body = { model: scenario === "native" ? "gpt-test" : "deepseek-test", input: [{ role: "user", content: "x".repeat(9000) }],
      ...(scenario === "output" ? { max_output_tokens: 2048 } : {}) };
    const response = await send(body); const text = await response.text();
    const allowed = ["native", "disabled", "missing"].includes(scenario);
    assert.equal(response.status, allowed ? 200 : 413, scenario + ": " + text);
    assert.equal(calls.length, allowed ? 1 : 0, scenario);
    if (scenario === "output") assert.match(text, /output_budget_exceeded/);
    if (scenario === "global") assert.equal(metrics[0].effective_input_limit_tokens, 150);
    if (scenario === "native") assert.equal(metrics[0].model_context_window, undefined);
  }
});

test("context budget boundaries accept exact estimate and reject one additional token", async context => {
  const customCatalog = { models: catalog.models.map(m => m.router_provider === "opencode" ? { ...m, context_window: 2048 } : m) };
  const limit = Math.floor(2048 * 0.95) - 512;
  const body = { model: "deepseek-test", input: [{ role: "user", content: "" }], max_output_tokens: 512 };
  const route = catalogRoutes(customCatalog).get("deepseek-test");
  while (estimateInputTokens(JSON.stringify(routedBody(body, route))) < limit) body.input[0].content += "xxxx";
  assert.equal(estimateInputTokens(JSON.stringify(routedBody(body, route))), limit);
  const { send } = await fixture(context, { catalog: customCatalog });
  const exact = await send(body); assert.equal(exact.status, 200); await exact.text();
  body.input[0].content += "xxxx";
  const over = await send(body); assert.equal(over.status, 413); await over.text();
});

test("context metadata is validated and is preserved for both slug and bare model aliases", () => {
  const customCatalog = { models: [{ slug: "opencode/small", router_model: "small", router_provider: "opencode", context_window: 4096 }] };
  const routes = catalogRoutes(customCatalog);
  assert.equal(routes.get("small").contextWindow, 4096);
  assert.equal(routes.get("opencode/small").contextWindow, 4096);
  for (const context_window of [0, -1, "4096", 3.5, Infinity, 10000001]) {
    assert.throws(() => catalogRoutes({ models: [{ ...customCatalog.models[0], context_window }] }), /コンテキスト/);
  }
});

test('分割要約の全体期限後にHTTP再試行しても完了したチャンクを再送しない', async context => {
  const metrics=[],summaries=[];
  const {send,calls}=await fixture(context,{summaryModel:'gpt-test',summaryInputLimitTokens:40000,
    timeoutMs:2500,handoffStatusDelayMs:1,onMetric:m=>metrics.push(m),
    upstreamResponse:async({provider,response,body})=>{
      if(provider!=='openai') return false;
      summaries.push(body);
      if(summaries.length===2) return true; // Hold this chunk until the router deadline.
      response.writeHead(200,{'content-type':'application/json'});
      response.end(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'checkpoint'}]}]}));
      return true;
    }});
  const body={model:'opencode/deepseek-test',stream:true,client_metadata:{thread_id:'checkpoint-thread'},
    input:[{role:'user',content:'x'.repeat(450000)},{type:'compaction',encrypted_content:'opaque'},{role:'user',content:'latest requirement'}]};
  const first=await send(body,{'session_id':'checkpoint-thread'});
  assert.match(await first.text(),/response.failed/);
  assert.equal(summaries.length,2);
  assert.equal(calls.filter(c=>c.provider==='opencode').length,0);
  const second=await send(body,{'session_id':'checkpoint-thread'});
  assert.equal(second.status,200);await second.text();
  assert.equal(JSON.stringify(summaries[2].input)===JSON.stringify(summaries[1].input),true,'resume at the interrupted chunk');
  assert.ok(metrics.some(m=>m.summary_checkpoint_hits>=1));
  assert.equal(calls.filter(c=>c.provider==='opencode').length,1);
  assert.equal(calls.at(-1).body.input.at(-1).content,'latest requirement');
});

test('巨大なremote compactionを上限内で処理し通常会話のOpenCodeモデルを保持する', async context => {
  const selected = 'opencode/deepseek-test';
  const { calls, send } = await fixture(context, { summaryModel: 'gpt-test', summaryInputLimitTokens: 40000,
    upstreamResponse: async ({ provider, response, body }) => {
      if (provider !== 'openai') return false;
      assert.ok(estimateInputTokens(body) + (body.max_output_tokens ?? 16384) < 40000);
      assert.deepEqual(body.tools, []);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'completed', model: 'gpt-test', output: body.input.some(item => item.type === 'compaction_trigger')
        ? [{ type: 'compaction', encrypted_content: 'synthetic-opaque' }]
        : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checkpoint' }] }] }));
      return true;
    } });
  const response = await send({ model: selected, tools: Array.from({ length: 57 }, (_, i) => ({ type: 'function', name: `tool_${i}`,
    description: 'x'.repeat(25000) })), input: [{ role: 'user', content: 'x'.repeat(450000) }, { role: 'assistant', content: 'completed work' },
      { role: 'user', content: 'latest task' }, { type: 'function_call', call_id: 'pending', name: 'read', arguments: '{}' }, { type: 'compaction_trigger' }] });
  assert.equal(response.status, 200, await response.text());
  assert.ok(calls.length > 2);
  assert.deepEqual(calls.at(-1).body.input.slice(-3), [{ role: 'user', content: 'latest task' },
    { type: 'function_call', call_id: 'pending', name: 'read', arguments: '{}' }, { type: 'compaction_trigger' }]);
  const after = await send({ model: selected, input: [{ role: 'user', content: 'continue' }] });
  assert.equal(after.status, 200); await after.text();
  assert.equal(calls.at(-1).provider, 'opencode');
  assert.equal(calls.at(-1).body.model, 'deepseek-test');
});

test('remote compactionは送信しないBridge reasoningを除いて要約後の容量を判定する', async context => {
  const { calls, send } = await fixture(context, { summaryModel: 'gpt-test', summaryInputLimitTokens: 40000,
    upstreamResponse: async ({ provider, response, body }) => {
      assert.equal(provider, 'openai');
      assert.ok(estimateInputTokens(body) + 16384 < 40000);
      assert.ok(!body.input.some(item => item.type === 'reasoning' && item.encrypted_content?.startsWith('cxb1:')));
      const compact = body.input.some(item => item.type === 'compaction_trigger');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'completed', output: compact
        ? [{ type: 'compaction', encrypted_content: 'native-checkpoint' }]
        : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'bounded summary' }] }] }));
      return true;
    } });
  const nativeReasoning = { type: 'reasoning', encrypted_content: 'native-opaque-content', summary: [] };
  const latest = { role: 'user', content: 'latest task ' + 'x'.repeat(20000) };
  const pending = { type: 'function_call', call_id: 'pending', name: 'read', arguments: '{}' };
  const input = [{ role: 'developer', content: 'Keep this instruction.' },
    { role: 'user', content: 'x'.repeat(450000) }, { role: 'assistant', content: 'finished work' },
    latest, { type: 'reasoning', encrypted_content: 'cxb1:' + 'x'.repeat(80000), summary: [] },
    nativeReasoning, pending, { type: 'compaction_trigger' }];
  const response = await send({ model: 'opencode/deepseek-test', input });
  assert.equal(response.status, 200, await response.text());
  assert.ok(calls.length > 1, 'genuine history still needs bounded summarization');
  assert.deepEqual(calls.at(-1).body.input.slice(-4), [latest, nativeReasoning, pending, { type: 'compaction_trigger' }]);
  assert.deepEqual(calls.at(-1).body.input[0], input[0]);
});

test('Bridge専用reasoningだけの肥大化でremote compactionの追加要約を発生させない', async context => {
  const { calls, send } = await fixture(context, { summaryModel: 'gpt-test', summaryInputLimitTokens: 40000 });
  const latest = { role: 'user', content: 'continue' };
  const response = await send({ model: 'opencode/deepseek-test', input: [
    { role: 'user', content: 'completed work' }, latest,
    { type: 'reasoning', encrypted_content: 'cxb1:' + 'x'.repeat(200000), summary: [] },
    { type: 'compaction_trigger' }] });
  assert.equal(response.status, 200, await response.text());
  assert.equal(calls.length, 1, 'no extra model call for data that is not sent');
  assert.deepEqual(calls[0].body.input, [{ role: 'user', content: 'completed work' }, latest, { type: 'compaction_trigger' }]);
});

test('OpenAI固有の暗号化reasoningはremote compactionの容量判定から除外しない', async context => {
  const { calls, send } = await fixture(context, { summaryModel: 'gpt-test', summaryInputLimitTokens: 40000 });
  const response = await send({ model: 'opencode/deepseek-test', input: [
    { role: 'user', content: 'latest task' },
    { type: 'reasoning', encrypted_content: 'native-' + 'x'.repeat(110000), summary: [] },
    { type: 'compaction_trigger' }] });
  assert.equal(response.status, 413, await response.text());
  assert.equal(calls.length, 0, 'native opaque data must not be silently discarded to fit');
});

test('remote compactionの保護指示だけで要約予算を超えた場合は上流へ送らない', async context => {
  const { calls, send } = await fixture(context, { summaryModel: 'gpt-test', summaryInputLimitTokens: 40000 });
  const response = await send({ model: 'opencode/deepseek-test', instructions: 'x'.repeat(200000),
    input: [{ role: 'user', content: 'continue' }, { type: 'compaction_trigger' }] });
  assert.equal(response.status, 413);
  assert.match(await response.text(), /summary_input_budget_exceeded/);
  assert.equal(calls.length, 0);
});

test('185万tokenの通常要求は段階要約後も57toolsと最新依頼とOpenCode宛先を保持する', async context => {
  const tools = Array.from({ length: 57 }, (_, i) => ({ type: 'function', name: `tool_${i}`, description: 's'.repeat(25000), parameters: { type: 'object' } }));
  const input = [{ role: 'developer', content: 'preserve directives' },
    ...Array.from({ length: 2120 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(2800) })),
    { role: 'user', content: 'latest task' }, { type: 'function_call', call_id: 'pending', name: 'tool_0', arguments: '{}' }];
  const original = structuredClone(input);
  const { calls, send } = await fixture(context, { summaryModel: 'gpt-test', opencodeSoftLimitTokens: 600000,
    upstreamResponse: async ({ provider, response, body }) => {
      if (provider !== 'openai') return false;
      assert.ok(estimateInputTokens(body) + body.max_output_tokens < 200000);
      assert.deepEqual(body.tools, []);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'checkpoint' }] }] }));
      return true;
    } });
  const result = await send({ model: 'opencode/deepseek-test', tools, input });
  assert.equal(result.status, 200, await result.text());
  assert.ok(calls.filter(call => call.provider === 'openai').length > 1);
  const final = calls.at(-1);
  assert.equal(final.provider, 'opencode');
  assert.equal(final.body.model, 'deepseek-test');
  assert.deepEqual(final.body.tools, tools);
  assert.deepEqual(final.body.input.slice(-2), input.slice(-2));
  assert.ok(estimateInputTokens(final.body) < 600000);
  assert.deepEqual(input, original);
});

test('要約モデルのcatalog上限も分割予算へ反映する', async context => {
  const { calls, send } = await fixture(context, { catalog: { models: [
    { slug: 'gpt-test', router_provider: 'openai', context_window: 32768 },
    { slug: 'opencode/deepseek-test', router_provider: 'opencode', router_model: 'deepseek-test' },
  ] }, summaryModel: 'gpt-test', opencodeSoftLimitTokens: 1000,
    upstreamResponse: async ({ provider, response, body }) => {
      if (provider !== 'openai') return false;
      assert.ok(estimateInputTokens(body) + 16384 < Math.floor(32768 * 0.8));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'checkpoint' }] }] }));
      return true;
    } });
  const result = await send({ model: 'opencode/deepseek-test', input: [{ role: 'user', content: 'x'.repeat(100000) },
    { role: 'user', content: 'recent' }, { role: 'user', content: 'latest' }] });
  assert.equal(result.status, 200, await result.text());
  assert.ok(calls.length > 2);
});


test('remote compactionでも最新依頼や未完了ツールを切り捨てて回復しない', async context => {
  const { calls, send } = await fixture(context, { summaryModel: 'gpt-test', summaryInputLimitTokens: 40000 });
  for (const input of [
    [{ role: 'user', content: 'x'.repeat(200000) }, { type: 'compaction_trigger' }],
    [{ role: 'user', content: 'old' }, { type: 'function_call', call_id: 'pending', name: 'read', arguments: '{}' },
      { role: 'user', content: 'x'.repeat(200000) }, { type: 'compaction_trigger' }],
  ]) {
    const response = await send({ model: 'opencode/deepseek-test', input });
    assert.equal(response.status, 413);
    assert.match(await response.text(), /summary_input_budget_exceeded/);
  }
  assert.equal(calls.length, 0);
});

test("upstream stream failure sends a safe terminal error instead of becoming a client cancellation", async context => {
  let record;
  const recorded = new Promise(resolve => { record = resolve; });
  const { send } = await fixture(context, { onMetric: record,
    fetcher: async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
      setTimeout(() => controller.error(new Error('secret-key private-message https://private.example')), 40);
    } }), { headers: { 'content-type': 'text/event-stream' } }) });
  const response = await send({ model: 'gpt-test', stream: true });
  const text = await response.text().catch(() => 'connection destroyed');
  const metric = await recorded;
  assert.match(text, /partial/);
  assert.match(text, /event: response.failed/);
  assert.match(text, /upstream_stream_error/);
  assert.match(text, /codex --profile direct/);
  assert.equal(metric.outcome, 'failed');
  assert.equal(metric.termination_reason, 'upstream_stream_error');
  assert.doesNotMatch(text + JSON.stringify(metric), /secret-key|private-message|private\.example/);
});

test("stream timeout sends a terminal error and records the deadline separately", async context => {
  let record, cancelled = false;
  const recorded = new Promise(resolve => { record = resolve; });
  const { send } = await fixture(context, { onMetric: record, timeoutMs: 100,
    fetcher: async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
    }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }) });
  const response = await send({ model: 'gpt-test', stream: true });
  const text = await response.text().catch(() => 'connection destroyed');
  const metric = await recorded;
  assert.match(text, /event: response.failed/);
  assert.match(text, /request_timeout/);
  assert.match(text, /codex --profile direct/);
  assert.equal(metric.outcome, 'timeout');
  assert.equal(metric.termination_reason, 'deadline_exceeded');
  assert.equal(cancelled, true);
});

test("relay connection failures include the direct GPT escape command but invalid JSON does not", async context => {
  const { send, base } = await fixture(context, { fetcher: async () => { throw new Error('private upstream detail'); } });
  const failed = await send({ model: 'gpt-test' });
  const failedText = await failed.text();
  assert.equal(failed.status, 502);
  assert.match(failedText, /codex --profile direct/);
  assert.doesNotMatch(failedText, /private upstream detail/);

  const invalid = await fetch(base + '/responses', { method: 'POST', headers: { authorization: 'Bearer test' }, body: '{' });
  const invalidText = await invalid.text();
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(invalidText, /codex --profile direct/);
});

test("client cancellation stops upstream without recording a provider failure", async context => {
  let record, cancelled = false;
  const recorded = new Promise(resolve => { record = resolve; });
  const { send } = await fixture(context, { onMetric: record,
    fetcher: async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
    }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }) });
  const response = await send({ model: 'gpt-test', stream: true });
  const reader = response.body.getReader();
  await reader.read(); await reader.cancel();
  const metric = await recorded;
  assert.equal(metric.outcome, 'aborted');
  assert.equal(metric.termination_reason, 'client_disconnected');
  assert.equal(metric.transport_error_code, undefined);
  assert.equal(cancelled, true);
});

test("a real upstream socket reset is reported through SSE without retrying inference", async context => {
  let record;
  const recorded = new Promise(resolve => { record = resolve; });
  const { send, calls } = await fixture(context, { onMetric: record,
    upstreamResponse: ({ response }) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"type":"response.output_text.delta","delta":"before reset"}\n\n');
      setTimeout(() => response.destroy(), 40);
      return true;
    } });
  const response = await send({ model: 'gpt-test', stream: true });
  const text = await response.text();
  const metric = await recorded;
  assert.match(text, /before reset/);
  assert.match(text, /upstream_stream_error/);
  assert.equal(metric.outcome, 'failed');
  assert.equal(metric.termination_reason, 'upstream_stream_error');
  assert.equal(metric.transport_error_code, 'UND_ERR_SOCKET');
  assert.equal(calls.length, 1);
});

test("a header timeout remains HTTP 504 with a separate deadline outcome", async context => {
  let record;
  const recorded = new Promise(resolve => { record = resolve; });
  const { send } = await fixture(context, { onMetric: record, timeoutMs: 50,
    fetcher: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('secret-timeout')), { once: true });
    }) });
  const response = await send({ model: 'gpt-test' });
  assert.equal(response.status, 504);
  const body = await response.json();
  assert.equal(body.error.type, 'request_timeout');
  assert.doesNotMatch(JSON.stringify(body), /secret-timeout/);
  const metric = await recorded;
  assert.equal(metric.outcome, 'timeout');
  assert.equal(metric.termination_reason, 'deadline_exceeded');
});

test("aborting an incomplete request body is classified as client input cancellation", async context => {
  let record;
  const recorded = new Promise(resolve => { record = resolve; });
  const { base, calls } = await fixture(context, { onMetric: record, timeoutMs: 2000 });
  const request = http.request(base + '/responses', { method: 'POST',
    headers: { authorization: 'Bearer synthetic-token', 'content-type': 'application/json' } });
  request.on('error', () => {});
  request.write('{"model":"gpt-test","input":"unfinished');
  await new Promise(resolve => setTimeout(resolve, 40));
  request.destroy();
  const metric = await recorded;
  assert.equal(metric.outcome, 'aborted');
  assert.equal(metric.termination_reason, 'client_request_aborted');
  assert.equal(calls.length, 0);
});
