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
