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
