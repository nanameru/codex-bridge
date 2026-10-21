import assert from "node:assert/strict";
import test from "node:test";
import { openCodeBody } from "../src/tool-adapter.mjs";

test("removes only adjacent identical instruction messages without trimming conversation or tool history", () => {
  const instruction = { type: "message", role: "developer", content: "constraints" };
  const body = { input: [instruction, structuredClone(instruction),
    { type: "message", role: "user", content: "request" }, instruction,
    { type: "function_call", call_id: "call", name: "probe", arguments: "{}" },
    { type: "function_call_output", call_id: "call", output: "tool output" },
    { type: "message", role: "assistant", content: "result" },
    { ...instruction, role: "system" }, instruction] };
  const before = structuredClone(body);
  const result = openCodeBody(body);
  assert.equal(result.input.length, body.input.length - 1);
  assert.deepEqual(result.input, body.input.filter((_item, index) => index !== 1));
  assert.deepEqual(body, before);
});
