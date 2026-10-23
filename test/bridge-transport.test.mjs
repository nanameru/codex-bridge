import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, rm, writeFile, readdir, readFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRouter } from "../src/model-router.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

test("actual bridge sends model controls and stable conversation sessions to mock upstream", { timeout: 15000 }, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-transport-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const internalKey = "a".repeat(64);
  await writeFile(join(directory, "bridge-local-token"), internalKey, { mode: 0o600 });
  const calls = [];
  const mock = http.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    calls.push({ body: JSON.parse(text), headers: request.headers });
    if (text.includes("UPSTREAM_PRIVATE_SENTINEL")) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "UPSTREAM_PRIVATE_SENTINEL" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }));
  });
  const mockPort = await listen(mock);
  context.after(async () => {
    mock.closeAllConnections();
    await new Promise((done) => mock.close(done));
  });
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise((done) => reservation.close(done));
  let script = join(root, "src/codex-bridge.mjs");
  if (process.env.LEGACY_BRIDGE_SOURCE) {
    script = join(directory, "codex-bridge.mjs");
    await copyFile(process.env.LEGACY_BRIDGE_SOURCE, script);
    await copyFile(join(root, "src/prices.json"), join(directory, "prices.json"));
    await copyFile(join(dirname(process.env.LEGACY_BRIDGE_SOURCE), "request-guard.mjs"), join(directory, "request-guard.mjs")).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if ((await readFile(script, "utf8")).includes('import { reasoningOptions, upstreamSession }')) {
      await copyFile(join(dirname(process.env.LEGACY_BRIDGE_SOURCE), "upstream-options.mjs"), join(directory, "upstream-options.mjs"));
    } else {
      const patched = spawnSync("python3", [join(root, "scripts/patch_legacy_bridge.py"), script, "--apply"], { encoding: "utf8" });
      assert.equal(patched.status, 0, patched.stderr);
    }
    const secured = spawnSync("python3", [join(root, "scripts/patch_legacy_security.py"), script, "--apply"], { encoding: "utf8" });
    assert.equal(secured.status, 0, secured.stderr);
  }
  if (process.env.LEGACY_BRIDGE_SOURCE) {
    const patched = spawnSync("python3", [join(root, "scripts/patch_chat_protocol.py"), script, "--apply"], { encoding: "utf8" });
    assert.equal(patched.status, 0, patched.stderr);
  }
  const child = spawn(process.execPath, [script], { env: { ...process.env, HOME: directory, CODEX_HOME: directory, PORT: String(port),
    OPENCODE_API_KEY: "dummy-test-token", UPSTREAM_BASE: `http://127.0.0.1:${mockPort}/v1`,
    CODEX_BRIDGE_TEST_UPSTREAM: "1",
    ALLOW_REQUEST_DUMP: "0", DISABLE_DUMP: "0", DUMP_DIR: join(directory, "dumps"), PRUNE_EXISTING_DUMPS: "0", USAGE_HOST: "", LOG_LEVEL: "info" }, stdio: ["ignore", "pipe", "pipe"] });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });
  let logs = "";
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("bridge startup timeout: " + logs)), 8000);
    child.stdout.on("data", (chunk) => {
      logs += chunk;
      if (logs.includes("codex-bridge listening")) { clearTimeout(timer); done(); }
    });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("bridge startup failed: " + logs)); });
  });
  for (const headers of [{}, { "x-codex-bridge-auth": "invented" }, { authorization: "Bearer invented" }]) {
    const rejected = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST",
      headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ input: "PRIVATE_TEXT" }) });
    assert.equal(rejected.status, 401);
  }
  assert.equal(calls.length, 0);
  for (const [model, effort, thread] of [["deepseek-v4.1-flash", "low", "chat-A"],
    ["deepseek-v4-pro", "high", "chat-A"], ["deepseek-v4.1-flash", "none", "chat-B"], ["hy4-preview", "low", "chat-B"]]) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST",
      headers: { "content-type": "application/json", "x-codex-bridge-auth": internalKey }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ model, reasoning: { effort }, prompt_cache_key: thread, input: "Hello", stream: false }) });
    assert.equal(response.status, 200, await response.text());
  }
  assert.equal(calls[0].body.reasoning_effort, "low");
  assert.equal(calls[1].body.reasoning_effort, "high");
  assert.deepEqual(calls[2].body.thinking, { type: "disabled" });
  assert.equal(calls[3].body.reasoning_effort, undefined);
  assert.equal(calls[3].body.thinking, undefined);
  const sessions = calls.map((call) => call.headers["x-opencode-session"]);
  assert.equal(sessions[0], sessions[1]);
  assert.equal(sessions[2], sessions[3]);
  assert.notEqual(sessions[0], sessions[2]);
  assert.ok(sessions.every((session) => /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(session)));
  assert.ok(calls.every((call) => call.headers["x-codex-bridge-auth"] === undefined));
  // Exercise both real auth boundaries together, not just isolated header assertions.
  await writeFile(join(directory, "auth.json"), JSON.stringify({ tokens: { access_token: "owner-test-token" } }), { mode: 0o600 });
  const router = createRouter({ codexRoot: directory, bridgeBase: `http://127.0.0.1:${port}/v1`,
    catalog: { models: [{ slug: "opencode/deepseek-v4.1-flash", router_provider: "opencode", router_model: "deepseek-v4.1-flash" }] } });
  const routerPort = await listen(router);
  context.after(async () => { router.closeAllConnections(); await new Promise((done) => router.close(done)); });
  const routed = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, { method: "POST", headers: {
    authorization: "Bearer owner-test-token", "content-type": "application/json",
  }, body: JSON.stringify({ model: "opencode/deepseek-v4.1-flash", input: "Hello", stream: false }) });
  assert.equal(routed.status, 200, await routed.text());
  assert.equal(calls.at(-1).headers.authorization, "Bearer dummy-test-token");
  assert.equal(calls.at(-1).headers["x-codex-bridge-auth"], undefined);
  // Verify an already-executed Codex custom tool remains a tool result at
  // the actual Chat boundary, not a fresh instruction or another tool call.
  const roundtrip = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, { method: "POST", headers: {
    authorization: "Bearer owner-test-token", "content-type": "application/json",
  }, body: JSON.stringify({ model: "opencode/deepseek-v4.1-flash", stream: false,
    tools: [{ type: "custom", name: "exec" }], input: [
      { role: "user", content: "Check then answer" },
      { type: "custom_tool_call", id: "ctc_saved", call_id: "saved-call", name: "exec", input: "printf CHECK" },
      { type: "custom_tool_call_output", call_id: "saved-call", output: "CHECK_RESULT" },
    ] }) });
  assert.equal(roundtrip.status, 200, await roundtrip.text());
  const messages = calls.at(-1).body.messages;
  const results = messages.filter(message => message.role === "tool");
  assert.deepEqual(results, [{ role: "tool", tool_call_id: "saved-call", content: "CHECK_RESULT" }]);
  const toolCalls = messages.flatMap(message => message.tool_calls ?? []);
  assert.deepEqual(toolCalls, [{ id: "saved-call", type: "function", function: { name: "exec", arguments: '{"input":"printf CHECK"}' } }]);
  // Large view_image results must survive both real adapters as image blocks,
  // rather than crossing the token guard as serialized Base64 text.
  const image = "data:image/png;base64," + "A".repeat(3 * 1024 * 1024);
  const multimodal = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, { method: "POST", headers: {
    authorization: "Bearer owner-test-token", "content-type": "application/json",
  }, body: JSON.stringify({ model: "opencode/deepseek-v4.1-flash", stream: false, input: [
    {role:"user",content:"Inspect screenshots"},
    ...["image-a","image-b"].map(call_id=>({type:"function_call",call_id,name:"view_image",arguments:"{}"})),
    ...["image-b","image-a"].map(call_id=>({type:"function_call_output",call_id,output:[{type:"input_image",image_url:image}]})),
    {role:"user",content:"Continue"},
  ] }) });
  assert.equal(multimodal.status, 200, await multimodal.text());
  const imageMessages = calls.at(-1).body.messages;
  assert.deepEqual(imageMessages.filter(m=>m.role==="tool").map(m=>m.tool_call_id), ["image-b","image-a"]);
  assert.ok(imageMessages.filter(m=>m.role==="tool").every(m=>!m.content.includes("base64")));
  const imageParts = imageMessages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==="image_url");
  assert.equal(imageParts.length, 2);
  assert.ok(imageParts.every(p=>p.image_url.url===image));
  const error = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: {
    "content-type": "application/json", "x-codex-bridge-auth": internalKey,
  }, body: JSON.stringify({ input: "UPSTREAM_PRIVATE_SENTINEL", stream: false }) });
  assert.equal(error.status, 400, await error.text());
  assert.doesNotMatch(logs, /PRIVATE_TEXT|dummy-test-token|UPSTREAM_PRIVATE_SENTINEL/);
  assert.deepEqual(await readdir(join(directory, "dumps")).catch(() => []), []);
});
