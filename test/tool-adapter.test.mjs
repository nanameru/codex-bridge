import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { nativeToolPayload, normalizeResponseStream, normalizeToolCallId, openCodeBody, toolResponseStream } from "../src/tool-adapter.mjs";

test("normalizes only mismatched tool item prefixes idempotently and preserves execution IDs", () => {
  for (const [type, id, expected] of [
    ["custom_tool_call", "fc_legacy", "ctc_legacy"],
    ["function_call", "ctc_native", "fc_native"],
    ["custom_tool_call", "ctc_native", "ctc_native"],
    ["function_call", "fc_native", "fc_native"],
    ["custom_tool_call_output", "fc_untouched", "fc_untouched"],
    ["message", "fc_untouched", "fc_untouched"],
    ["custom_tool_call", undefined, undefined],
  ]) {
    const original = { type, id, call_id: "call_stable" };
    const fixed = normalizeToolCallId(original);
    assert.deepEqual(fixed, { ...original, id: expected });
    assert.deepEqual(normalizeToolCallId(fixed), fixed);
    assert.equal(original.id, id);
  }
});

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
  assert.match(converted.tools[0].description, /JSON object containing exactly one string field/);
  assert.match(converted.tools[0].description, /Format of the input string value/);
  assert.equal(JSON.parse(converted.input[0].arguments).input, body.input[0].input);
  assert.equal(converted.input[1].type, "function_call_output");
  assert.equal(converted.input[1].call_id, "call_1");
  assert.equal(converted.input[0].id, "fc_1");
  assert.deepEqual(converted.tool_choice, { type: "function", function: { name: "apply_patch" } });
  assert.equal(body.tools[0].type, "custom");
});

test("restores freeform outputs while leaving regular functions unchanged", () => {
  const output = [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", arguments: '{"input":"patch"}' },
    { type: "function_call", id: "fc_2", call_id: "call_2", name: "shell", arguments: '{"command":"pwd"}' }];
  const result = nativeToolPayload({ output }, new Set(["apply_patch"]));
  assert.equal(result.output[0].type, "custom_tool_call");
  assert.equal(result.output[0].input, "patch");
  assert.equal(result.output[0].id, "ctc_1");
  assert.equal(result.output[0].call_id, "call_1");
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
  const payloads = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
  assert.deepEqual(payloads.filter((value) => value.item).map((value) => value.item.id), ["ctc_1", "ctc_1"]);
  assert.equal(payloads.at(-1).response.output[0].id, "ctc_1");
  assert.equal(item.id, "fc_1");
});

test("adapts non-streaming JSON responses", async () => {
  const payload = { output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", arguments: '{"input":"patch"}' }] };
  const stream = Readable.from([Buffer.from(JSON.stringify(payload))]).pipe(toolResponseStream(new Set(["apply_patch"]), "application/json", 10000));
  let text = "";
  for await (const chunk of stream) text += chunk;
  assert.equal(JSON.parse(text).output[0].input, "patch");
  assert.equal(JSON.parse(text).output[0].id, "ctc_1");
});

test("normalizes OpenCode assistant messages to GPT-compatible phases", () => {
  const finalMessage = { type: "message", role: "assistant", status: "completed", content: [] };
  const commentary = { ...finalMessage, phase: "commentary" };
  const userMessage = { type: "message", role: "user", content: [] };
  const result = nativeToolPayload({ item: finalMessage, output: [finalMessage, commentary, userMessage],
    response: { output: [finalMessage] } }, new Set());
  assert.equal(result.item.phase, "final_answer");
  assert.equal(result.output[0].phase, "final_answer");
  assert.equal(result.output[1].phase, "commentary");
  assert.equal(result.output[2].phase, undefined);
  assert.equal(result.response.output[0].phase, "final_answer");
  assert.equal(finalMessage.phase, undefined);
});

test("adds final_answer phase to streamed OpenCode assistant messages", async () => {
  const item = { type: "message", id: "msg_1", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "PHASE_OK", annotations: [], logprobs: [] }] };
  const events = [
    { type: "response.output_item.added", item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, delta: "PHASE_OK" },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { output: [item] } },
  ];
  const bytes = Buffer.from(events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""));
  let text = "";
  for await (const chunk of Readable.from([bytes]).pipe(toolResponseStream(new Set(), "text/event-stream", 10000))) text += chunk;
  const payloads = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
  assert.deepEqual(payloads.filter((value) => value.item?.type === "message").map((value) => value.item.phase),
    ["final_answer", "final_answer"]);
  assert.equal(payloads.at(-1).response.output[0].phase, "final_answer");
  assert.equal(item.phase, undefined);
});

test("normalizes phases on direct Responses SSE without changing other items", async () => {
  const message = { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] };
  const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "shell", arguments: "{}" };
  const events = [
    { type: "response.output_item.added", sequence_number: 7, item: message },
    { type: "response.output_text.delta", sequence_number: 8, item_id: message.id, delta: "OK" },
    { type: "response.output_item.done", sequence_number: 9, item: call },
    { type: "response.completed", sequence_number: 10, response: { output: [message, call] } },
  ];
  const frames = events.map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
  let text = "";
  for await (const chunk of Readable.from([Buffer.from(frames)]).pipe(normalizeResponseStream("text/event-stream", 10000))) text += chunk;
  const payloads = text.split("\n").filter((line) => line.startsWith("data:") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(5)));
  assert.equal(payloads[0].item.phase, "final_answer");
  assert.equal(payloads[1].sequence_number, 8);
  assert.equal(payloads[2].item.type, "function_call");
  assert.equal(payloads[2].item.phase, undefined);
  assert.equal(payloads[3].response.output[0].phase, "final_answer");
  assert.match(text, /data: \[DONE\]/);
  assert.equal(message.phase, undefined);
});

test("normalizes phases on direct non-streaming Responses JSON", async () => {
  const payload = { output: [{ type: "message", id: "msg_1", role: "assistant", content: [] }] };
  let text = "";
  for await (const chunk of Readable.from([Buffer.from(JSON.stringify(payload))])
    .pipe(normalizeResponseStream("application/json", 10000))) text += chunk;
  assert.equal(JSON.parse(text).output[0].phase, "final_answer");
  assert.equal(payload.output[0].phase, undefined);
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
