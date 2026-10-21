import assert from "node:assert/strict";
import test from "node:test";
import { reasoningOptions, upstreamSession } from "../src/upstream-options.mjs";

test("maps DeepSeek thinking controls without silently lowering the selected effort", () => {
  for (const model of ["deepseek-v4.1-flash", "deepseek-v4-pro"]) {
    assert.deepEqual(reasoningOptions(model, "none"), { thinking: { type: "disabled" } });
    for (const [effort, expected] of [["minimal", "low"], ["low", "low"], ["medium", "high"],
      ["high", "high"], ["xhigh", "high"], ["max", "max"], ["ultra", "max"]]) {
      assert.deepEqual(reasoningOptions(model, effort), { thinking: { type: "enabled" }, reasoning_effort: expected });
    }
  }
  for (const model of ["hy4-preview", "kimi-k3", "deepseek-v3", "gpt-test"]) {
    assert.deepEqual(reasoningOptions(model, "low"), {});
  }
  assert.deepEqual(reasoningOptions("deepseek-v4-pro", undefined), {});
  assert.deepEqual(reasoningOptions("deepseek-v4-pro", "invalid"), {});
});

test("keeps session stable per thread across models without exposing thread IDs", () => {
  const first = upstreamSession({ prompt_cache_key: "private-thread" }, "fallback");
  assert.match(first, /^cxb-[a-f0-9]{64}$/);
  assert.equal(first, upstreamSession({ client_metadata: { thread_id: "private-thread" }, model: "other" }, "new-fallback"));
  assert.notEqual(first, upstreamSession({ prompt_cache_key: "other-thread" }, "fallback"));
  for (const thread of [undefined, {}, "", "a".repeat(201)]) {
    assert.equal(upstreamSession({ prompt_cache_key: thread }, "fallback"), "fallback");
  }
});
