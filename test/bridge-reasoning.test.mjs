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

function decodeReasoning(value) {
  assert.match(value, /^cxb1:/);
  return Buffer.from(value.slice(5), "base64url").toString("utf8");
}
async function startBridge(context, respond) {
  const directory = await mkdtemp(join(tmpdir(), "bridge-transport-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const internalKey = "a".repeat(64);
  await writeFile(join(directory, "bridge-local-token"), internalKey, { mode: 0o600 });
  const calls = [];
  const mock = http.createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); calls.push({ body, headers: request.headers });
    await respond(body, calls.length - 1, response);
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
    // Existing imports do not prove all legacy upgrades (e.g. Retry-After) are installed.
    const upgraded = spawnSync("python3", [join(root, "scripts/patch_legacy_bridge.py"), script, "--apply"], { encoding: "utf8" });
    assert.equal(upgraded.status, 0, upgraded.stderr);
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
  const post = body => fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST",
    headers: { "content-type": "application/json", "x-codex-bridge-auth": internalKey },
    signal: AbortSignal.timeout(5000), body: JSON.stringify(body) });
  return { calls, post };
}
const jsonResponder = (message = { role: "assistant", content: "OK" }) => async (_body, _index, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }));
};

test("merges assistant content and tool calls and fills missing reasoning in thinking mode", async (context) => {
  const { calls, post } = await startBridge(context, jsonResponder());
  const encrypted = "cxb1:" + Buffer.from("deepseek thought", "utf8").toString("base64url");
  const input = [
    { type: "message", role: "user", content: "start" },
    { type: "reasoning", encrypted_content: encrypted },
    { type: "message", role: "assistant", content: "old answer" },
    { type: "function_call", call_id: "call_old", name: "exec", arguments: "{}" },
    { type: "function_call_output", call_id: "call_old", output: "ok" },
    { type: "message", role: "assistant", content: "second answer" },
    { type: "function_call", call_id: "call_second", name: "exec", arguments: "{}" },
    { type: "function_call_output", call_id: "call_second", output: "ok" },
  ];
  const response = await post({ model: "deepseek-v4.1-flash", reasoning: { effort: "high" }, input, stream: false });
  assert.equal(response.status, 200, await response.text());

  const assistants = calls[0].body.messages.filter((message) => message.role === "assistant");
  assert.equal(assistants.length, 2);
  assert.equal(assistants[0].content, "old answer");
  assert.equal(assistants[0].reasoning_content, "deepseek thought");
  assert.deepEqual(assistants[0].tool_calls.map((tool) => tool.id), ["call_old"]);
  assert.equal(assistants[1].content, "second answer");
  assert.ok(assistants[1].reasoning_content);
  assert.notEqual(assistants[1].reasoning_content, "deepseek thought");
  assert.deepEqual(assistants[1].tool_calls.map((tool) => tool.id), ["call_second"]);
});

test("does not add reasoning_content when thinking is disabled", async (context) => {
  const { calls, post } = await startBridge(context, jsonResponder());
  const input = [
    { type: "message", role: "user", content: "start" },
    { type: "message", role: "assistant", content: "old answer" },
    { type: "function_call", call_id: "call_old", name: "exec", arguments: "{}" },
    { type: "function_call_output", call_id: "call_old", output: "ok" },
  ];
  const response = await post({ model: "deepseek-v4.1-flash", reasoning: { effort: "none" }, input, stream: false });
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(calls[0].body.thinking, { type: "disabled" });
  for (const message of calls[0].body.messages.filter((entry) => entry.role === "assistant")) {
    assert.equal(Object.hasOwn(message, "reasoning_content"), false);
  }
});

test("round-trips non-streaming reasoning text through encrypted Responses items", async (context) => {
  const { calls, post } = await startBridge(context, jsonResponder({
    role: "assistant",
    reasoning_content: "private chain",
    content: "answer",
  }));
  const first = await post({
    model: "deepseek-v4.1-flash",
    reasoning: { effort: "high" },
    input: [{ type: "message", role: "user", content: "question" }],
    stream: false,
  });
  const firstText = await first.text();
  assert.equal(first.status, 200, firstText);
  const payload = JSON.parse(firstText);
  const reasoning = payload.output.find((item) => item.type === "reasoning");
  assert.ok(reasoning);
  assert.equal(decodeReasoning(reasoning.encrypted_content), "private chain");
  assert.equal(payload.output.find((item) => item.type === "message").content[0].text, "answer");

  const second = await post({
    model: "deepseek-v4.1-flash",
    reasoning: { effort: "high" },
    input: [
      { type: "message", role: "user", content: "question" },
      reasoning,
      { type: "message", role: "assistant", content: "answer" },
      { type: "message", role: "user", content: "next" },
    ],
    stream: false,
  });
  assert.equal(second.status, 200, await second.text());
  const assistant = calls[1].body.messages.find((message) => message.role === "assistant");
  assert.equal(assistant.reasoning_content, "private chain");
});

test("emits streaming reasoning as an encrypted Responses item", async (context) => {
  const { post } = await startBridge(context, async (body, _index, response) => {
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "sse thought" } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "sse answer" } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  const response = await post({
    model: "deepseek-v4.1-flash",
    reasoning: { effort: "high" },
    input: [{ type: "message", role: "user", content: "question" }],
    stream: true,
  });
  assert.equal(response.status, 200);
  const events = (await response.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()));
  const done = events.find((event) => event.type === "response.output_item.done" && event.item?.type === "reasoning");
  assert.ok(done);
  assert.equal(decodeReasoning(done.item.encrypted_content), "sse thought");
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed.response.output[0].type, "reasoning");
  assert.equal(completed.response.output[0].encrypted_content, done.item.encrypted_content);
});
