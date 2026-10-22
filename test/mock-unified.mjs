import http from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRouter } from "../src/model-router.mjs";

const catalog = JSON.parse(readFileSync(process.env.CODEX_HOME + "/unified-model-catalog.json", "utf8"));
const calls = [];
const toolMode = process.env.MOCK_TOOL_ROUNDTRIP === "1";
const codeMode = process.env.MOCK_CODE_MODE === "1";
const mock = (provider) => http.createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  const lastUser = body.input?.findLastIndex((item) => item.role === "user") ?? -1;
  const current = body.input?.slice(lastUser + 1) ?? [];
  const hasToolOutput = current.some((item) => ["function_call_output", "custom_tool_call_output"].includes(item.type));
  if (toolMode && process.env.MOCK_DIRECT_RESPONSES !== "1" && provider === "opencode" && hasToolOutput) {
    let reasoning = false;
    for (const item of current) {
      if (item.type === "reasoning") reasoning = item.encrypted_content?.startsWith("cxb1:");
      else if ((item.type === "function_call" || item.role === "assistant") && !reasoning) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "reasoning_content must precede the tool call" } }));
        return;
      }
      else if (item.role === "assistant") reasoning = false;
    }
  }
  calls.push({ provider, path: request.url, model: body.model, inputItems: body.input?.length ?? 0,
    inputTypes: body.input?.map((item) => item.type), previousResponse: Boolean(body.previous_response_id),
    reasoningProviders: body.input?.filter((item) => item.type === "reasoning").map((item) => item.encrypted_content?.startsWith("cxb1:") ? "opencode" : "openai"),
    hasNativeAuth: Boolean(request.headers.authorization) && request.headers.authorization !== "Bearer mock-opencode-key",
    toolsCount: body.tools?.length ?? 0, toolsBytes: Buffer.byteLength(JSON.stringify(body.tools ?? [])),
    toolTypes: body.tools?.map((tool) => tool.type) ?? [],
    requestBytes: Buffer.byteLength(text),
    codeModeOutput: hasToolOutput && JSON.stringify(current).includes("CODE_MODE_OK") });
  const identifier = "resp_mock_" + calls.length;
  const reasoning = { id: "rs_" + calls.length, type: "reasoning", summary: [],
    encrypted_content: provider === "openai" ? "fake-native-encrypted" : "cxb1:ZmFrZQ" };
  const item = { id: "msg_" + calls.length, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: provider + "_OK", annotations: [] }] };
  const result = { id: identifier, object: "response", model: body.model, status: "completed",
    created_at: Math.floor(Date.now() / 1000), output: [reasoning, item],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
  response.writeHead(200, { "content-type": "text/event-stream" });
  let sequence = 0;
  const emit = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  emit("response.created", { response: { ...result, output: [], status: "in_progress" } });
  emit("response.output_item.added", { output_index: 0, item: reasoning });
  if (codeMode && !hasToolOutput) {
    const call = { id: "ctc_" + calls.length, type: "custom_tool_call", call_id: "call_" + calls.length,
      name: "exec", input: 'text(await tools.exec_command({cmd: "printf CODE_MODE_OK"}));', status: "completed" };
    emit("response.output_item.done", { output_index: 0, item: reasoning });
    emit("response.output_item.added", { output_index: 1, item: call });
    emit("response.output_item.done", { output_index: 1, item: call });
    emit("response.completed", { response: { ...result, output: [reasoning, call] } });
    response.end();
    return;
  }
  if (toolMode && !hasToolOutput) {
    const call = { id: "fc_" + calls.length, type: "function_call", call_id: "call_" + calls.length,
      name: "route_probe", arguments: "{}", status: "completed" };
    if (provider === "openai") emit("response.output_item.done", { output_index: 0, item: reasoning });
    const commentary = { ...item, content: [{ type: "output_text", text: "Checking the command.", annotations: [] }] };
    emit("response.output_item.added", { output_index: 1, item: commentary });
    emit("response.output_item.done", { output_index: 1, item: commentary });
    emit("response.output_item.added", { output_index: 2, item: call });
    emit("response.output_item.done", { output_index: 2, item: call });
    if (provider === "opencode") emit("response.output_item.done", { output_index: 0, item: reasoning });
    emit("response.completed", { response: { ...result, output: [reasoning, commentary, call] } });
    response.end();
    return;
  }
  if (!toolMode || provider === "openai") emit("response.output_item.done", { output_index: 0, item: reasoning });
  emit("response.output_item.added", { output_index: 1, item: { ...item, status: "in_progress", content: [] } });
  emit("response.content_part.added", { item_id: item.id, output_index: 1, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  emit("response.output_text.delta", { item_id: item.id, output_index: 1, content_index: 0, delta: provider + "_OK" });
  emit("response.output_text.done", { item_id: item.id, output_index: 1, content_index: 0, text: provider + "_OK" });
  emit("response.content_part.done", { item_id: item.id, output_index: 1, content_index: 0, part: item.content[0] });
  emit("response.output_item.done", { output_index: 1, item });
  if (toolMode && provider === "opencode") emit("response.output_item.done", { output_index: 0, item: reasoning });
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
const bridgeBase = await bind(bridge);
const router = createRouter({ catalog, nativeBase: await bind(native), bridgeBase, openCodeBase: bridgeBase,
  openCodeKey: () => "mock-opencode-key", allowTestOrigins: true });
const url = await bind(router);
process.stdout.write(JSON.stringify({ url }) + "\n");
process.stdin.on("data", () => process.stdout.write(JSON.stringify({ calls }) + "\n"));
process.stdin.on("end", () => {
  for (const server of [router, native, bridge]) { server.closeAllConnections(); server.close(); }
});
