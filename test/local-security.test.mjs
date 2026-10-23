import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRouter } from "../src/model-router.mjs";
import { validateOpenCodeBase, fetchOpenCode } from "../src/local-security.mjs";

async function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), "router-security-"));
  const auth = join(root, "auth.json");
  const bridgeKey = "b".repeat(64);
  writeFileSync(auth, JSON.stringify({ tokens: { access_token: "owner-token" } }), { mode: 0o600 });
  writeFileSync(join(root, "bridge-local-token"), bridgeKey, { mode: 0o600 });
  const calls = [];
  const server = createRouter({ codexRoot: root, catalog: { models: [
    { slug: "gpt-test", router_provider: "openai" },
    { slug: "opencode/test", router_model: "test", router_provider: "opencode" },
    { slug: "opencode/direct", router_model: "direct", router_provider: "opencode", router_transport: "responses" },
  ] }, openCodeKey: () => "opencode-key", fetcher: async (url, options) => {
    calls.push({ url, ...options });
    return Response.json({ output: [] });
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (model = "gpt-test", headers = {}) => fetch(base + "/v1/responses", {
    method: "POST", headers: { authorization: "Bearer owner-token", "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, input: "private text" }),
  });
  return { root, auth, bridgeKey, calls, server, base, send };
}

test("rejects arbitrary Bearer tokens on native and OpenCode routes before calling upstream", async (context) => {
  const { send, calls } = await fixture(context);
  for (const model of ["gpt-test", "opencode/test", "opencode/direct"]) {
    assert.equal((await send(model, { authorization: "Bearer invented-token" })).status, 401);
  }
  assert.equal(calls.length, 0);
});

test("rejects browser Origins and foreign Hosts even with the owner credential", async (context) => {
  const { send, calls, base } = await fixture(context);
  for (const headers of [{ origin: "https://evil.example" }, { origin: "null" }]) {
    assert.equal((await send("opencode/test", headers)).status, 403);
  }
  const status = await new Promise((resolve, reject) => {
    const request = http.request(base + "/v1/responses", { method: "POST", headers: {
      host: "evil.example", authorization: "Bearer owner-token", "content-type": "application/json",
    } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
    request.end(JSON.stringify({ model: "opencode/test" }));
  });
  assert.equal(status, 403);
  assert.equal(calls.length, 0);
});

test("owner authentication is reloaded after refresh; missing, public and linked files fail closed", async (context) => {
  const { send, calls, auth, root } = await fixture(context);
  assert.equal((await send()).status, 200);
  writeFileSync(auth, JSON.stringify({ tokens: { access_token: "new-owner-token" } }));
  assert.equal((await send()).status, 401);
  assert.equal((await send("gpt-test", { authorization: "Bearer new-owner-token" })).status, 200);
  chmodSync(auth, 0o644);
  assert.equal((await send("gpt-test", { authorization: "Bearer new-owner-token" })).status, 401);
  chmodSync(auth, 0o600);
  const target = join(root, "other-auth.json");
  writeFileSync(target, JSON.stringify({ tokens: { access_token: "new-owner-token" } }), { mode: 0o600 });
  rmSync(auth);
  symlinkSync(target, auth);
  assert.equal((await send("gpt-test", { authorization: "Bearer new-owner-token" })).status, 401);
  rmSync(auth);
  assert.equal((await send()).status, 401);
  assert.equal(calls.length, 2);
});

test("internal bridge credentials never accompany native or official OpenCode requests", async (context) => {
  const { send, calls, bridgeKey } = await fixture(context);
  const malicious = { "x-codex-bridge-auth": "attacker-controlled" };
  assert.equal((await send("gpt-test", malicious)).status, 200);
  assert.equal((await send("opencode/test", malicious)).status, 200);
  assert.equal((await send("opencode/direct", { ...malicious, "x-codex-bridge-direct": "1" })).status, 200);
  assert.equal(calls[0].headers.authorization, "Bearer owner-token");
  assert.equal(calls[0].headers["x-codex-bridge-auth"], undefined);
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(calls[1].headers["x-codex-bridge-auth"], bridgeKey);
  assert.equal(calls[2].headers.authorization, "Bearer opencode-key");
  assert.equal(calls[2].headers["x-codex-bridge-auth"], undefined);
});

test("a missing internal key never falls back to unauthenticated legacy forwarding", async (context) => {
  const { root, send, calls } = await fixture(context);
  rmSync(join(root, "bridge-local-token"));
  assert.equal((await send("opencode/test")).status, 503);
  assert.equal(calls.length, 0);
});

test("expired owner JWTs and malformed credential files never authorize OpenCode", async (context) => {
  const { auth, send, calls } = await fixture(context);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const expired = encode({ alg: "none" }) + "." + encode({ exp: 1 }) + ".test-only";
  writeFileSync(auth, JSON.stringify({ tokens: { access_token: expired } }));
  assert.equal((await send("opencode/test", { authorization: `Bearer ${expired}` })).status, 401);
  writeFileSync(auth, "{broken");
  assert.equal((await send("opencode/test")).status, 401);
  assert.equal(calls.length, 0);
});

test("legacy upstream is official-only and never follows redirects with credentials or history", async () => {
  assert.equal(validateOpenCodeBase("https://opencode.ai/inference/go/openai/v1", false), "https://opencode.ai/inference/go/openai/v1");
  for (const url of ["https://evil.example/v1", "https://opencode.ai.evil.example/v1", "https://secret@opencode.ai/inference/go/openai/v1",
    "http://127.0.0.1:8788/v1", "https://opencode.ai/inference/go/openai/v1?key=secret"]) {
    assert.throws(() => validateOpenCodeBase(url, false));
  }
  let called = 0;
  await assert.rejects(fetchOpenCode("https://opencode.ai/inference/go/openai/v1/chat/completions", { headers: { authorization: "Bearer secret" } },
    async (_url, options) => {
      called++;
      assert.equal(options.redirect, "manual");
      return new Response("", { status: 307, headers: { location: "https://evil.example" } });
    }), /redirect rejected/);
  assert.equal(called, 1);
});
