import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { nativeToolPayload, openCodeBody, toolResponseStream } from "../src/tool-adapter.mjs";

test("preserves freeform tool history and schemas through the chat bridge", () => {
  const body = {
    tools: [{ type: "custom", name: "apply_patch", description: "edit", format: { type: "text" } }],
    tool_choice: { type: "custom", name: "apply_patch" },
    input: [{ type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "apply_patch", input: "patch\n日本語" },
      { type: "custom_tool_call_output", call_id: "call_1", output: "ok" }],
  };
  const converted = openCodeBody(body);
  assert.equal(converted.tools[0].type, "function");
  assert.equal(converted.tools[0].parameters.properties.input.type, "string");
  assert.equal(JSON.parse(converted.input[0].arguments).input, body.input[0].input);
  assert.equal(converted.input[1].type, "function_call_output");
  assert.equal(converted.input[1].call_id, "call_1");
  assert.deepEqual(converted.tool_choice, { type: "function", function: { name: "apply_patch" } });
  assert.equal(body.tools[0].type, "custom");
});

test("restores freeform outputs while leaving regular functions unchanged", () => {
  const output = [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", arguments: '{"input":"patch"}' },
    { type: "function_call", id: "fc_2", call_id: "call_2", name: "shell", arguments: '{"command":"pwd"}' }];
  const result = nativeToolPayload({ output }, new Set(["apply_patch"]));
  assert.equal(result.output[0].type, "custom_tool_call");
  assert.equal(result.output[0].input, "patch");
  assert.equal(result.output[0].arguments, undefined);
  assert.deepEqual(result.output[1], output[1]);
  assert.throws(() => nativeToolPayload({ item: { ...output[0], arguments: "{}" } }, new Set(["apply_patch"])));
  assert.throws(() => nativeToolPayload({ item: { ...output[0], arguments: "" } }, new Set(["apply_patch"])));
  assert.throws(() => nativeToolPayload({ response: { response: {} } }, new Set(["apply_patch"])));
});

test("adapts split UTF-8 SSE items and final response without buffering the whole stream", async () => {
  const item = { type: "function_call", id: "fc_1", name: "apply_patch", call_id: "call_1", arguments: '{"input":"日本語"}' };
  const events = [
    { type: "response.output_item.added", item },
    { type: "response.function_call_arguments.done", item_id: item.id, arguments: item.arguments },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { output: [item] } },
  ];
  const bytes = Buffer.from(events.map((value) => `event: ${value.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`).join(""));
  const chunks = Array.from(bytes, (value) => Buffer.from([value]));
  const stream = Readable.from(chunks).pipe(toolResponseStream(new Set(["apply_patch"]), "text/event-stream", 10000));
  let text = "";
  for await (const chunk of stream) text += chunk;
  assert.match(text, /custom_tool_call/);
  assert.match(text, /日本語/);
  assert.doesNotMatch(text, /function_call_arguments/);
  assert.doesNotMatch(text, /"type":"function_call"/);
});

test("adapts non-streaming JSON responses", async () => {
  const payload = { output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", arguments: '{"input":"patch"}' }] };
  const stream = Readable.from([Buffer.from(JSON.stringify(payload))]).pipe(toolResponseStream(new Set(["apply_patch"]), "application/json", 10000));
  let text = "";
  for await (const chunk of stream) text += chunk;
  assert.equal(JSON.parse(text).output[0].input, "patch");
});

test("repairs trailing bridge reasoning for each assistant message and tool group without crossing turns", () => {
  const reasoning = { type: "reasoning", encrypted_content: "cxb1:dGhpbmtpbmc", summary: [] };
  const message = { type: "message", role: "assistant", content: "checking" };
  const call = { type: "function_call", call_id: "call_1", name: "noop", arguments: "{}" };
  const output = { type: "function_call_output", call_id: "call_1", output: "OK" };
  const user = { type: "message", role: "user", content: "next" };
  const input = [message, call, reasoning, output, user, message];
  assert.deepEqual(openCodeBody({ input }).input, [reasoning, message, reasoning, call, output, user, message]);
  assert.deepEqual(input, [message, call, reasoning, output, user, message]);
  assert.deepEqual(openCodeBody({ input: [reasoning, call, { ...call, call_id: "call_2" }, output] }).input,
    [reasoning, call, { ...call, call_id: "call_2" }, output]);
});

test("completes reasoning before assistant items even when the bridge emits it last", async () => {
  const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "cxb1:dGhpbmtpbmc" };
  const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "noop", arguments: "{}" };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...reasoning, encrypted_content: undefined } },
    { type: "response.output_item.added", output_index: 1, item: call },
    { type: "response.output_item.done", output_index: 1, item: call },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.completed", response: { output: [reasoning, call] } },
  ];
  const bytes = events.map((value, sequence_number) => `data: ${JSON.stringify({ ...value, sequence_number })}\n\n`).join("");
  let text = "";
  for await (const chunk of Readable.from([Buffer.from(bytes)]).pipe(toolResponseStream(new Set(), "text/event-stream", 10000))) text += chunk;
  const output = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
  assert.deepEqual(output.filter((value) => value.type === "response.output_item.done").map((value) => value.item.type),
    ["reasoning", "function_call"]);
  assert.deepEqual(output.map((value) => value.sequence_number), [0, 1, 2, 3, 4]);
});

test("bounds expanded history and does not invent missing reasoning", () => {
  const reasoning = { type: "reasoning", encrypted_content: "cxb1:" + "x".repeat(80) };
  const message = { type: "message", role: "assistant", content: "check" };
  const call = { type: "function_call", name: "noop", arguments: "{}" };
  assert.throws(() => openCodeBody({ input: [reasoning, message, call] }, 250), /expanded history/);
  assert.deepEqual(openCodeBody({ input: [message, call] }).input, [message, call]);
});

test("does not release a tool call on a truncated or failed reasoning stream", async () => {
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
    { type: "response.output_item.done", output_index: 1, item: { type: "function_call", name: "noop", arguments: "{}" } },
  ];
  const encode = (values) => Buffer.from(values.map((value) => "data: " + JSON.stringify(value) + "\n\n").join(""));
  let text = "";
  await assert.rejects(async () => {
    for await (const chunk of Readable.from([encode(events)]).pipe(toolResponseStream(new Set(), "text/event-stream", 10000))) text += chunk;
  }, /reasoning completion/);
  assert.doesNotMatch(text, /"type":"function_call"/);
  text = "";
  for await (const chunk of Readable.from([encode([...events, { type: "response.failed", response: { status: "failed" } }])])
    .pipe(toolResponseStream(new Set(), "text/event-stream", 10000))) text += chunk;
  assert.match(text, /response.failed/);
  assert.doesNotMatch(text, /"type":"function_call"/);
});
