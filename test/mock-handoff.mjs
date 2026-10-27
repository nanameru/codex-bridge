import http from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRouter } from "../src/model-router.mjs";
import { WAIT_TEXT } from "../src/handoff-status.mjs";
import { createLiveCatalog } from "../src/live-catalog.mjs";

const catalog = JSON.parse(readFileSync(process.env.CODEX_HOME + "/unified-model-catalog.json"));
const calls = [];
let connectFailures = 0;
const mock = (provider) => http.createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  const summary = Boolean(body.instructions?.startsWith("Produce only"));
  const compactEndpoint = Boolean(request.url.endsWith("/compact"));
  const compactionTrigger = Boolean(body.input?.some((item) => item.type === "compaction_trigger"));
  const compact = compactEndpoint || (compactionTrigger && provider === "openai");
  calls.push({ provider, model: body.model, summary, compact, compactEndpoint, compactionTrigger, hasNativeAuth: Boolean(request.headers.authorization),
    outputLimit: body.max_output_tokens,
    statusReplayed: JSON.stringify(body.input).includes(WAIT_TEXT), inputTypes: body.input?.map((item) => item.type),
    ...(process.env.MOCK_HANDOFF_TOOLS === "1" ? { toolResults: body.input?.filter(item => item.type === "function_call_output" && JSON.stringify(item.output).includes("BRIDGE_STATUS_TOOL_OK")).length } : {}) });
  if (summary) {
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.MOCK_HANDOFF_DELAY_MS ?? 160)));
    if (process.env.MOCK_HANDOFF_FAIL === "1") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":{"message":"private upstream error"}}');
      return;
    }
    if (process.env.MOCK_HANDOFF_TRANSIENT === "1" && calls.filter(call => call.summary).length === 1) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('event: response.failed\ndata: ' + JSON.stringify({ type: "response.failed",
        response: { status: "failed", error: { code: "server_error", message: "private upstream error" } } }) + '\n\n');
      return;
    }
    if (calls.filter(call => call.summary).length === 1 && ["incomplete", "empty"].includes(process.env.MOCK_HANDOFF_RESULT)) {
      const incomplete = process.env.MOCK_HANDOFF_RESULT === "incomplete";
      const type = incomplete ? "response.incomplete" : "response.completed";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`event: ${type}\ndata: ${JSON.stringify({ type, response: {
        status: incomplete ? "incomplete" : "completed", output: [],
        ...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
      } })}\n\n`);
      return;
    }
  }
  const id = "resp_mock_" + calls.length;
  if (provider === "opencode" && process.env.MOCK_HANDOFF_TOOLS === "1") {
    const hasResult = (body.input ?? []).some(item => item.type === "function_call_output");
    const round = hasResult ? 1 : 0;
    const reasoning = { id: "rs_mock_" + round, type: "reasoning", summary: [] };
    const item = !hasResult
      ? { id: "fc_mock_" + round, type: "function_call", call_id: "call_mock_" + round,
        name: "exec_command", arguments: JSON.stringify({ cmd: "printf BRIDGE_STATUS_TOOL_OK", max_output_tokens: 100 }) }
      : { id: "msg_mock_final", type: "message", role: "assistant", phase: "final_answer", status: "completed",
        content: [{ type: "output_text", text: "opencode_OK", annotations: [] }] };
    const result = { id, object: "response", model: body.model, status: "completed", output: [reasoning, item] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    let sequence = 0;
    const emit = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
    emit("response.created", { response: { ...result, status: "in_progress", output: [] } });
    emit("response.output_item.added", { output_index: 0, item: reasoning });
    emit("response.output_item.done", { output_index: 0, item: reasoning });
    // Leave time for the real TUI to restore its heading after an empty summary.
    await new Promise(resolve => setTimeout(resolve, 1500));
    emit("response.output_item.added", { output_index: 1, item });
    emit("response.output_item.done", { output_index: 1, item });
    emit("response.completed", { response: result });
    response.end();
    return;
  }
  const item = compact ? { id: "cmp_mock", type: "compaction", encrypted_content: "mock-native-compaction" }
    : { id: "msg_mock_" + calls.length, type: "message", role: "assistant", phase: "final_answer", status: "completed",
      content: [{ type: "output_text", text: summary ? "PORTABLE SUMMARY" : provider + "_OK", annotations: [] }] };
  const result = { id, object: "response", created_at: Math.floor(Date.now() / 1000), model: body.model,
    status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
  response.writeHead(200, { "content-type": "text/event-stream" });
  let sequence = 0;
  const emit = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  emit("response.created", { response: { ...result, status: "in_progress", output: [] } });
  emit("response.output_item.added", { output_index: 0, item: compact ? item : { ...item, status: "in_progress", content: [] } });
  if (!compact) {
    emit("response.content_part.added", { output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } });
    emit("response.output_text.delta", { output_index: 0, content_index: 0, item_id: item.id, delta: item.content[0].text });
    emit("response.output_text.done", { output_index: 0, content_index: 0, item_id: item.id, text: item.content[0].text });
    emit("response.content_part.done", { output_index: 0, content_index: 0, item_id: item.id, part: item.content[0] });
  }
  emit("response.output_item.done", { output_index: 0, item });
  emit("response.completed", { response: summary && process.env.MOCK_HANDOFF_THIN === "1" ? { ...result, output: [] } : result });
  response.end();
});
async function bind(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}/v1`;
}
const native = mock("openai");
const bridge = mock("opencode");
let advanced = false;
const catalogProvider = process.env.MOCK_LIVE_CATALOG === "1" ? createLiveCatalog({
  initial: catalog, seed: JSON.parse(readFileSync(new URL("../src/models.json", import.meta.url))).models,
  key: () => "fake-go-key", ttlMs: 0, fetcher: async url => {
    if (url.includes("chatgpt.com")) return Response.json({ models: catalog.models.filter(m => m.router_provider === "openai") });
    if (url.includes("models.dev")) return Response.json({ "opencode-go": { models: { "future-test": { name: "Future Test", limit: { context: 128000, output: 32000 } } } } });
    const ids = catalog.models.filter(m => m.router_provider === "opencode").map(m => m.router_model);
    return Response.json({ data: [...ids, ...(advanced ? ["future-test"] : [])].map(id => ({ id })) });
  },
}) : undefined;
const router = createRouter({ catalog, nativeBase: await bind(native), bridgeBase: await bind(bridge),
  allowTestOrigins: true, bridgeKey: () => "fake-internal-key", handoffStatusDelayMs: 20, catalogProvider,
  fetcher: async (url, init) => {
    if (process.env.MOCK_HANDOFF_CONNECT_TIMEOUT === "1" && !connectFailures && JSON.parse(init.body).instructions?.startsWith("Produce only")) {
      connectFailures++; throw new TypeError("fake connection timeout", { cause: { code: "ETIMEDOUT" } });
    }
    return fetch(url, init);
  } });
const url = await bind(router);
process.stdout.write(JSON.stringify({ url }) + "\n");
process.stdin.on("data", data => {
  if (data.toString().trim() === "advance") { advanced = true; process.stdout.write('{"advanced":true}\n'); }
  else process.stdout.write(JSON.stringify({ calls, connectFailures }) + "\n");
});
process.stdin.on("end", () => {
  for (const server of [router, native, bridge]) { server.closeAllConnections(); server.close(); }
});
