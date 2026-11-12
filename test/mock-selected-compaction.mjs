// Issue #186: fake upstreams where OpenAI is at its usage limit for compaction.
import http from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRouter } from "../src/model-router.mjs";

const catalog = JSON.parse(readFileSync(process.env.CODEX_HOME + "/unified-model-catalog.json"));
const calls = [];
const metrics = [];
const mock = provider => http.createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  const summary = Boolean(body.instructions?.startsWith("Produce only"));
  const wire = JSON.stringify(body.input ?? []);
  const compactionTrigger = Boolean(body.input?.some(item => item.type === "compaction_trigger"));
  calls.push({ provider, summary, compactionTrigger, hasNativeAuth: Boolean(request.headers.authorization),
    hasSelectedSummary: wire.includes("SELECTED_E2E_SUMMARY"), hasRouterWrapper: wire.includes("cxbsel1:"),
    inputTypes: body.input?.map(item => item.type) });
  if (provider === "openai" && (compactionTrigger || request.url.endsWith("/compact"))) {
    response.writeHead(429, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { type: "usage_limit_reached", code: "usage_limit_reached",
      message: "You've hit your usage limit.", resets_at: Math.floor(Date.now() / 1000) + 3600 } }));
    return;
  }
  const item = { id: "msg_mock_" + calls.length, type: "message", role: "assistant", phase: "final_answer", status: "completed",
    content: [{ type: "output_text", text: summary ? "SELECTED_E2E_SUMMARY" : provider + "_OK", annotations: [] }] };
  const result = { id: "resp_mock_" + calls.length, object: "response", created_at: Math.floor(Date.now() / 1000), model: body.model,
    status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
  response.writeHead(200, { "content-type": "text/event-stream" });
  let sequence = 0;
  const emit = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  emit("response.created", { response: { ...result, status: "in_progress", output: [] } });
  emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  emit("response.content_part.added", { output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } });
  emit("response.output_text.delta", { output_index: 0, content_index: 0, item_id: item.id, delta: item.content[0].text });
  emit("response.output_text.done", { output_index: 0, content_index: 0, item_id: item.id, text: item.content[0].text });
  emit("response.content_part.done", { output_index: 0, content_index: 0, item_id: item.id, part: item.content[0] });
  emit("response.output_item.done", { output_index: 0, item });
  emit("response.completed", { response: result });
  response.end();
});
async function bind(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}/v1`;
}
const native = mock("openai");
const bridge = mock("opencode");
const router = createRouter({ catalog, nativeBase: await bind(native), bridgeBase: await bind(bridge),
  allowTestOrigins: true, bridgeKey: () => "fake-internal-key", historyMode: process.env.MOCK_HISTORY_MODE ?? "selected",
  onMetric: metric => metrics.push(metric) });
const url = await bind(router);
process.stdout.write(JSON.stringify({ url }) + "\n");
process.stdin.on("data", () => {
  process.stdout.write(JSON.stringify({ calls, metrics: metrics.map(m => ({ path: m.path, model: m.model, status: m.status,
    remote_compaction_fallback: m.remote_compaction_fallback, remote_compaction_openai_skipped: m.remote_compaction_openai_skipped,
    remote_compaction_openai_status: m.remote_compaction_openai_status, selected_compaction_restored: m.selected_compaction_restored })) }) + "\n");
});
process.stdin.on("end", () => {
  for (const server of [router, native, bridge]) { server.closeAllConnections(); server.close(); }
});
