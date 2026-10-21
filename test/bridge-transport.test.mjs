import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

test("actual bridge sends model controls and stable conversation sessions to mock upstream", { timeout: 15000 }, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-transport-"));
  const calls = [];
  const mock = http.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    calls.push({ body: JSON.parse(text), headers: request.headers });
    if (calls.at(-1).body.model === "test-quota") {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
      response.end(JSON.stringify({ error: { type: "rate_limit_exceeded" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }));
  });
  const mockPort = await listen(mock);
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise((done) => reservation.close(done));
  let script = join(root, "src/codex-bridge.mjs");
  if (process.env.LEGACY_BRIDGE_SOURCE) {
    script = join(directory, "codex-bridge.mjs");
    await copyFile(process.env.LEGACY_BRIDGE_SOURCE, script);
    await copyFile(join(root, "src/prices.json"), join(directory, "prices.json"));
    const patched = spawnSync("python3", [join(root, "scripts/patch_legacy_bridge.py"), script, "--apply"], { encoding: "utf8" });
    assert.equal(patched.status, 0, patched.stderr);
  }
  const child = spawn(process.execPath, [script], { env: { ...process.env, HOME: directory, PORT: String(port),
    OPENCODE_API_KEY: "dummy-test-token", UPSTREAM_BASE: `http://127.0.0.1:${mockPort}/v1`,
    DISABLE_DUMP: "1", PRUNE_EXISTING_DUMPS: "0", USAGE_HOST: "", LOG_LEVEL: "info" }, stdio: ["ignore", "pipe", "pipe"] });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    mock.closeAllConnections();
    await new Promise((done) => mock.close(done));
    await rm(directory, { recursive: true, force: true });
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
  for (const [model, effort, thread] of [["deepseek-v4.1-flash", "low", "chat-A"],
    ["deepseek-v4-pro", "high", "chat-A"], ["deepseek-v4.1-flash", "none", "chat-B"], ["hy4-preview", "low", "chat-B"]]) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST",
      headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5000),
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
  const limited = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "test-quota", input: "Hello", stream: false }) });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(calls.length, 5);
});
