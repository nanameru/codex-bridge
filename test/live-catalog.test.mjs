import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createLiveCatalog, discoveredModels, boundedJSON } from "../src/live-catalog.mjs";
import { createRouter } from "../src/model-router.mjs";

const seed = [{ id: "old", name: "Old", desc: "Existing", ctx: 128000, out: 32000, vision: false, efforts: ["low", "high"], tier: "fast" }];
const initial = { models: [{ slug: "gpt-test", router_provider: "openai" },
  { slug: "opencode/old", router_provider: "opencode", router_model: "old" }] };
const headers = { authorization: "Bearer OWNER", "chatgpt-account-id": "ACCOUNT" };
function setup(extra = {}) {
 let clock = 0; let ids = ["old"]; let goFailure = false; let nativeFailure = false; let metaFailure = false;
 const calls = []; const status = [];
 const live = createLiveCatalog({ initial, seed, key: () => "GO_KEY", now: () => clock, ttlMs: 100,
  retryMs: 10, onStatus: s => status.push(s), fetcher: async (url, init) => {
   calls.push({ url, init }); assert.equal(init.redirect, "error");
   if (url.includes("models.dev")) { if (metaFailure) throw Error("PRIVATE"); return Response.json({ "opencode-go": { models: Object.fromEntries(ids.map(id => [id, { name: id, modalities: { input: ["text", "image"] }, limit: { context: 262144, output: 32768 }, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] }])) } }); }
   if (url.includes("opencode.ai")) return goFailure ? Response.json({ error: "PRIVATE" }, { status: 503 }) : Response.json({ data: ids.map(id => ({ id })) });
   if (nativeFailure) throw Error("PRIVATE");
   return Response.json({ models: [{ slug: "gpt-test", display_name: "GPT", base_instructions: "Keep native instructions", context_window: 500000 }] });
  }, ...extra });
 return { live, calls, status, clock: x => { clock = x; }, ids: x => { ids = x; }, fail: (go, native = false, meta = false) => { goFailure = go; nativeFailure = native; metaFailure = meta; } };
}

test("discovery uses the actual Go list, validated metadata and conservative unknown capabilities", () => {
 const result = discoveredModels({ data: [{ id: "kimi-k3.1-pro" }, { id: "unknown" }] }, [["kimi-k3.1-pro", {
  name: "Kimi", modalities: { input: ["image"] }, limit: { context: 1048576, output: 131072 },
  reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
 }], ["not-on-go", {}]], seed);
 assert.equal(result.length, 2); assert.equal(result[0].slug, "opencode/kimi-k3.1-pro");
 assert.deepEqual(result[0].supported_reasoning_levels.map(x => x.effort), ["low", "high", "max"]);
 assert.deepEqual(result[0].input_modalities, ["text", "image"]);
 assert.equal(result[0].router_transport, "chat");
 assert.equal(result[1].context_window, 128000); assert.ok(result[1].auto_compact_token_limit < 128000);
 for (const data of [[], [{ id: "../evil" }], [{ id: "ok" }, { id: "ok" }], Array(501).fill({ id: "x" })]) {
  assert.throws(() => discoveredModels({ data }, [], seed));
 }
});

test("catalog shares concurrent refreshes, respects TTL and adds new routable models without restarting", async () => {
 const f = setup();
 const [a, b] = await Promise.all([f.live.get(headers, "0.164.0"), f.live.get(headers, "0.164.0")]);
 assert.deepEqual(a, b); assert.equal(f.calls.length, 3);
 assert.equal(a.models[0].base_instructions, "Keep native instructions");
 f.ids(["old", "new"]); await f.live.get(headers, "0.164.0"); assert.equal(f.calls.length, 3);
 f.clock(101); const updated = await f.live.get(headers, "0.164.0");
 assert.ok(updated.models.some(m => m.slug === "opencode/new")); assert.equal(f.calls.length, 6);
 for (const { url, init } of f.calls) {
  if (url.includes("models.dev")) assert.equal(init.headers.authorization, undefined);
  else assert.equal(init.headers.authorization, url.includes("opencode.ai") ? "Bearer GO_KEY" : "Bearer OWNER");
 }
});

test("failed refresh keeps the previous snapshot, backs off, and metadata lag does not hide actual new models", async () => {
 const f = setup(); await f.live.get(headers, "0.164.0");
 f.clock(101); f.fail(true, true); const old = await f.live.get(headers, "0.164.0");
 assert.ok(old.models.some(m => m.slug === "opencode/old")); const count = f.calls.length;
 await f.live.get(headers, "0.164.0"); assert.equal(f.calls.length, count);
 f.clock(112); f.ids(["new"]); f.fail(false, false, true);
 const updated = await f.live.get(headers, "0.164.0");
 assert.ok(updated.models.some(m => m.slug === "opencode/new"));
 assert.doesNotMatch(JSON.stringify(f.status), /PRIVATE|OWNER|GO_KEY/);
});

test("native catalog caches are partitioned by credentials, account, originator and client version", async () => {
 const f = setup(); await f.live.get(headers, "0.164.0");
 await f.live.get({ ...headers, originator: "app" }, "0.164.0");
 await f.live.get({ ...headers, "chatgpt-account-id": "SECOND" }, "0.164.0");
 await f.live.get({ ...headers, authorization: "Bearer SECOND" }, "0.164.0");
 await f.live.get(headers, "0.165.0");
 assert.equal(f.calls.filter(c => c.url.includes("chatgpt.com")).length, 5);
 f.fail(false, true); await assert.rejects(f.live.get({ authorization: "Bearer THIRD" }, "0.164.0"));
 await assert.rejects(f.live.get({}, "0.164.0")); await assert.rejects(f.live.get(headers, "../../evil"));
});

test("oversized, empty and malformed provider catalogs cannot overwrite a successful snapshot", async () => {
 let broken = false;
 const f = setup({ fetcher: async url => url.includes("chatgpt.com") ? Response.json({ models: [{ slug: "gpt-test" }] })
  : url.includes("models.dev") ? Response.json({}) : Response.json({ data: broken ? [{ id: "ok" }, { id: "ok" }] : [{ id: "old" }] }) });
 await f.live.get(headers, "0.164.0"); broken = true; f.clock(101);
 const result = await f.live.get(headers, "0.164.0"); assert.ok(result.models.some(m => m.slug === "opencode/old"));
 await assert.rejects(boundedJSON(new Response("x".repeat(101)), 100));
 await assert.rejects(boundedJSON(Response.json({}, { status: 302 }), 100));
 await assert.rejects(boundedJSON(new Response("not JSON"), 100));
});

test("authenticated Codex catalog updates routes atomically, returns ETags, and never exposes internal fields", async context => {
 const f = setup(); const requests = [];
 const router = createRouter({ catalog: initial, catalogProvider: f.live, authenticate: () => true,
  bridgeKey: () => "INTERNAL", fetcher: async (_url, init) => { requests.push(JSON.parse(init.body)); return Response.json({ status: "completed", output: [] }); } });
 router.listen(0, "127.0.0.1"); await once(router, "listening");
 context.after(() => { router.closeAllConnections(); router.close(); });
 const base = "http://127.0.0.1:" + router.address().port;
 assert.equal((await fetch(base + "/codex/models?client_version=0.164.0")).status, 401);
 assert.equal(f.calls.length, 0);
 assert.equal((await fetch(base + "/codex/models?client_version=bad", { headers })).status, 400);
 const response = await fetch(base + "/codex/models?client_version=0.164.0", { headers });
 assert.equal(response.status, 200); const etag = response.headers.get("etag");
 const first = await response.json(); assert.ok(first.models.some(m => m.slug === "opencode/old"));
 assert.ok(first.models.every(m => m.router_provider === undefined));
 assert.equal((await fetch(base + "/codex/models?client_version=0.164.0", { headers: { ...headers, "if-none-match": etag } })).status, 304);
 f.clock(101); f.ids(["old", "new"]);
 assert.equal((await fetch(base + "/codex/models?client_version=0.164.0", { headers })).status, 200);
 const answer = await fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "opencode/new", input: "hello" }) });
 assert.equal(answer.status, 200); await answer.text(); assert.equal(requests[0].model, "new");
 assert.equal((await (await fetch(base + "/health")).json()).live_catalog, true);
});

test("catalog updates do not interrupt an existing inference request", async context => {
 const f = setup(); let release; let entered;
 const started = new Promise(resolve => { entered = resolve; });
 const router = createRouter({ catalog: initial, catalogProvider: f.live, authenticate: () => true, bridgeKey: () => "INTERNAL",
  fetcher: async (_url, init) => {
   if (JSON.parse(init.body).model === "old") {
    entered(); await new Promise(resolve => { release = resolve; }); assert.equal(init.signal.aborted, false);
   }
   return Response.json({ status: "completed", output: [] });
  } });
 router.listen(0, "127.0.0.1"); await once(router, "listening");
 context.after(() => { router.closeAllConnections(); router.close(); });
 const base = "http://127.0.0.1:" + router.address().port;
 const pending = fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "opencode/old", input: "work" }) });
 await started; f.ids(["new"]);
 const updated = await fetch(base + "/codex/models?client_version=0.164.0", { headers });
 assert.equal(updated.status, 200); await updated.text();
 release(); const answer = await pending; assert.equal(answer.status, 200); await answer.text();
 const removed = await fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "opencode/old", input: "work" }) });
 assert.equal(removed.status, 400); assert.match(await removed.text(), /unknown_model/);
});

test("cached metadata survives an outage and is not downloaded on every catalog access", async () => {
 const f = setup(); await f.live.get(headers, "0.164.0");
 const metadataCalls = () => f.calls.filter(c => c.url.includes("models.dev")).length;
 assert.equal(metadataCalls(), 1);
 f.clock(101); f.fail(false, false, true);
 const catalog = await f.live.get(headers, "0.164.0");
 assert.equal(metadataCalls(), 1);
 assert.deepEqual(catalog.models.find(m => m.slug === "opencode/old").input_modalities, ["text", "image"]);
});

test("active native catalog identities survive LRU eviction", async () => {
 const f = setup();
 const get = account => f.live.get({ ...headers, "chatgpt-account-id": account }, "0.164.0");
 for (let i = 0; i < 8; i++) await get(String(i));
 const nativeCalls = () => f.calls.filter(c => c.url.includes("chatgpt.com")).length;
 assert.equal(nativeCalls(), 8);
 await get("0"); await get("8"); assert.equal(nativeCalls(), 9);
 await get("0"); assert.equal(nativeCalls(), 9, "the active first caller remains cached");
 await get("1"); assert.equal(nativeCalls(), 10, "the least recently used caller was evicted");
});

test("native catalog preserves evolving metadata but removes prototype keys and route overrides", async () => {
 const value = JSON.parse('{"slug":"gpt-test","__proto__":{"polluted":true},"constructor":"unsafe","prototype":"unsafe","router_transport":"responses","router_provider":"opencode","router_model":"evil","future_capability":{"enabled":true}}');
 const f = setup({ fetcher: async url => url.includes("chatgpt.com") ? Response.json({ models: [value] })
  : url.includes("models.dev") ? Response.json({}) : Response.json({ data: [{ id: "old" }] }) });
 const result = (await f.live.get(headers, "0.164.0")).models[0];
 assert.equal(result.router_provider, "openai"); assert.equal(result.router_model, "gpt-test");
 for (const name of ["__proto__", "constructor", "prototype", "router_transport"]) assert.equal(Object.hasOwn(result, name), false);
 assert.deepEqual(result.future_capability, { enabled: true }); assert.equal({}.polluted, undefined);
});

test("a cached client model can refresh a restarted router before model/list runs again", async context => {
 const f = setup(); f.ids(["new"]); const forwarded = [];
 const router = createRouter({ catalog: initial, catalogProvider: f.live, authenticate: () => true, bridgeKey: () => "INTERNAL",
  fetcher: async (_url, init) => { forwarded.push(JSON.parse(init.body)); return Response.json({ status: "completed", output: [] }); } });
 router.listen(0, "127.0.0.1"); await once(router, "listening");
 context.after(() => { router.closeAllConnections(); router.close(); });
 const base = "http://127.0.0.1:" + router.address().port;
 const response = await fetch(base + "/v1/responses", { method: "POST", headers: { ...headers, version: "0.164.0" },
  body: JSON.stringify({ model: "opencode/new", input: "continue" }) });
 assert.equal(response.status, 200, await response.text()); assert.equal(forwarded[0].model, "new");
 const missing = await fetch(base + "/v1/responses", { method: "POST", headers: { ...headers, version: "0.164.0" },
  body: JSON.stringify({ model: "opencode/never-provided", input: "continue" }) });
 assert.equal(missing.status, 400); await missing.text(); assert.equal(forwarded.length, 1);
});
