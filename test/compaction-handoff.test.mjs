import assert from "node:assert/strict";
import test from "node:test";
import { compactionHandoff } from "../src/compaction-handoff.mjs";

const body = { input: [
  { role: "developer", content: "constraints" },
  { type: "compaction", id: "old-id", encrypted_content: "opaque" },
  { role: "user", content: "latest" },
] };
const options = () => ({ destination: "https://chatgpt.com/backend-api/codex",
  headers: { authorization: "Bearer test", "chatgpt-account-id": "account" },
  signal: new AbortController().signal, threadId: "thread" });
const completed = () => Response.json({ status: "completed", output: [
  { type: "message", content: [{ type: "output_text", text: "handoff" }] },
] });

test("releases a completed SSE handoff without waiting for the connection to close", { timeout: 2000 }, async () => {
  let cancelled = false;
  const expand = compactionHandoff({ model: "gpt-test", maxBytes: 10000,
    fetcher: async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify({ type: "response.completed",
        response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "handoff" }] }] },
      }) + "\n\n"));
    }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }) });
  const result = await expand(body, options());
  assert.match(result.input[1].content[0].text, /handoff/);
  assert.equal(cancelled, true);
});

test("reuses handoff despite instruction and display metadata changes, preserving current instructions", async () => {
  let calls = 0;
  const expand = compactionHandoff({ model: "gpt-test", maxBytes: 10000,
    fetcher: async () => { calls++; return completed(); } });
  await expand(body, options());
  const changed = structuredClone(body);
  changed.input[0].content = "new constraints";
  changed.input[1].id = "new-id";
  changed.input[1].status = "completed";
  const result = await expand(changed, options());
  assert.equal(calls, 1);
  assert.equal(result.input[0].content, "new constraints");
  assert.equal(result.input.at(-1).content, "latest");
  assert.equal(body.input[1].id, "old-id");
});

test("deduplicates concurrent summaries and a cancelled waiter does not cancel another", async () => {
  let release;
  let calls = 0;
  let upstreamSignal;
  const gate = new Promise((resolve) => { release = resolve; });
  const expand = compactionHandoff({ model: "gpt-test", maxBytes: 10000,
    fetcher: async (_url, init) => { calls++; upstreamSignal = init.signal; await gate; return completed(); } });
  const abort = new AbortController();
  const first = expand(body, { ...options(), signal: abort.signal });
  const second = expand(body, options());
  abort.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(upstreamSignal.aborted, false);
  release();
  assert.equal((await second).input[1].content[0].text.includes("handoff"), true);
  assert.equal(calls, 1);
});

test("isolates threads, credentials and changed history; failed summaries are retried", async () => {
  let calls = 0;
  const expand = compactionHandoff({ model: "gpt-test", maxBytes: 10000,
    fetcher: async () => { calls++; return calls === 1 ? new Response("", { status: 503 }) : completed(); } });
  await assert.rejects(expand(body, options()));
  await expand(body, options());
  await expand(body, { ...options(), threadId: "other" });
  await expand(body, { ...options(), headers: { authorization: "Bearer other" } });
  const changed = structuredClone(body);
  changed.input[1].encrypted_content = "different";
  await expand(changed, options());
  assert.equal(calls, 5);
});

test("does not cache requests lacking a usable thread ID", async () => {
  let calls = 0;
  const expand = compactionHandoff({ model: "gpt-test", maxBytes: 10000,
    fetcher: async () => { calls++; return completed(); } });
  for (const threadId of [undefined, undefined, "", "", "x".repeat(201)]) {
    await expand(body, { ...options(), threadId });
  }
  assert.equal(calls, 5);
});

test("handles cancellation during synchronous fetch setup before waiter registration", async () => {
  const abort = new AbortController();
  const expand = compactionHandoff({ model: "gpt-test", maxBytes: 10000,
    fetcher: async () => { abort.abort(); return completed(); } });
  await assert.rejects(expand(body, { ...options(), signal: abort.signal }), { name: "AbortError" });
});

test("aborts generation when all waiters leave and never caches its result", async () => {
  let calls = 0;
  const expand = compactionHandoff({ model: "gpt-test", maxBytes: 10000,
    fetcher: async (_url, init) => {
      calls++;
      if (calls > 1) return completed();
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort",
        () => reject(init.signal.reason), { once: true }));
    } });
  const abort = new AbortController();
  const pending = expand(body, { ...options(), signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await expand(body, options());
  assert.equal(calls, 2);
});
