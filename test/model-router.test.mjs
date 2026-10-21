import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import * as zlib from "node:zlib";
import { catalogRoutes, createRouter, routedBody } from "../src/model-router.mjs";

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

test("does not silently discard compacted history when switching to OpenCode", async (context) => {
  const { calls, send } = await fixture(context);
  const response = await send({ model: "deepseek-test", input: [{ type: "compaction", encrypted_content: "native-opaque" }] });
  assert.equal(response.status, 422);
  assert.equal(calls.length, 0);
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

for (const path of ["/images/generations", "/images/edits", "/alpha/search"]) {
  test(`native tool ${path} bypasses model routing and preserves the request`, async (context) => {
    const { calls, base } = await fixture(context);
    const body = { model: "not-in-catalog", input: "opaque tool input", previous_response_id: "tool-reference", prompt: "stars", images: [{ image_url: "data:image/png;base64,AA==" }], settings: { future: true } };
    const response = await fetch(base + path, { method: "POST", headers: {
      authorization: "Bearer fake-native-token", "content-type": "application/json",
      "chatgpt-account-id": "test-account", "x-codex-image-turn-id": "test-turn", "x-secret": "discard",
    }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].provider, "openai");
    assert.equal(calls[0].path, "/v1" + path);
    assert.deepEqual(calls[0].body, body);
    assert.equal(calls[0].headers.authorization, "Bearer fake-native-token");
    assert.equal(calls[0].headers["chatgpt-account-id"], "test-account");
    assert.equal(calls[0].headers["x-codex-image-turn-id"], "test-turn");
    assert.equal(calls[0].headers["x-secret"], undefined);
  });
}

test("native tools reject missing auth, unsupported methods and unknown routes", async (context) => {
  const { calls, base } = await fixture(context);
  for (const path of ["/images/generations", "/images/edits", "/alpha/search"]) {
    assert.equal((await fetch(base + path, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(base + path)).status, 404);
  }
  for (const path of ["/images/generations/extra", "/alpha/search/extra", "/arbitrary", "/images/generations?redirect=example"]) {
    assert.equal((await fetch(base + path, { method: "POST", headers: { authorization: "Bearer fake" }, body: "{}" })).status, 404);
  }
  assert.equal(calls.length, 0);
});

test("native tools preserve image response bytes, status and request diagnostics", async (context) => {
  const bytes = JSON.stringify({ data: [{ b64_json: "AA==" }], output_format: "png" });
  const { base } = await fixture(context, { fetcher: async () => new Response(bytes, { status: 429, headers: {
    "content-type": "application/json", "retry-after": "12", "x-request-id": "outer", "x-codex-imagegen-request-id": "inner", "set-cookie": "must-not-forward",
  } }) });
  const response = await fetch(base + "/images/generations", { method: "POST", headers: { authorization: "Bearer fake" }, body: "{}" });
  assert.equal(response.status, 429);
  assert.equal(await response.text(), bytes);
  assert.equal(response.headers.get("retry-after"), "12");
  assert.equal(response.headers.get("x-codex-imagegen-request-id"), "inner");
  assert.equal(response.headers.get("set-cookie"), null);
});

test("native tools block redirects, invalid JSON and compression expansion", async (context) => {
  let calls = 0;
  const { base } = await fixture(context, { maxBytes: 100, timeoutMs: 100, fetcher: async (_url, options) => {
    calls++;
    assert.equal(options.redirect, "manual");
    return new Response("redirect", { status: 307, headers: { location: "https://example.com" } });
  } });
  const send = (body, extra = {}) => fetch(base + "/alpha/search", { method: "POST", headers: { authorization: "Bearer fake", ...extra }, body });
  assert.equal((await send("{}")).status, 502);
  assert.equal((await send("not json")).status, 400);
  assert.equal((await send(zlib.gzipSync(JSON.stringify({ prompt: "x".repeat(200) })), { "content-encoding": "gzip" })).status, 413);
  assert.equal(calls, 1);
});

test("native tools time out without completing an unresponsive upstream", async (context) => {
  const { base } = await fixture(context, { timeoutMs: 25, fetcher: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }) });
  const response = await fetch(base + "/images/generations", { method: "POST", headers: { authorization: "Bearer fake" }, body: "{}" });
  assert.equal(response.status, 504);
});

test("native tool destinations remain official for ChatGPT and API authentication", async (context) => {
  const destinations = [];
  const server = createRouter({ catalog, fetcher: async (url) => {
    destinations.push(url);
    return new Response("{}", { headers: { "content-type": "application/json" } });
  } });
  const base = await listen(server);
  context.after(() => close(server));
  for (const token of ["fake-chatgpt-token", "sk-fake-api-key"]) {
    await (await fetch(base + "/images/edits", { method: "POST", headers: { authorization: "Bearer " + token }, body: "{}" })).text();
  }
  assert.deepEqual(destinations, ["https://chatgpt.com/backend-api/codex/images/edits", "https://api.openai.com/v1/images/edits"]);
});

test("native tools negotiate JSON rather than a conversation event stream", async (context) => {
  const { base } = await fixture(context, { fetcher: async (_url, options) => {
    assert.equal(options.headers.accept, "application/json");
    return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { headers: { "content-type": "application/json" } });
  } });
  const response = await fetch(base + "/images/generations", { method: "POST", headers: { authorization: "Bearer fake" }, body: "{}" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [{ b64_json: "AA==" }] });
});
