import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithAvailabilityRetry } from "../src/model-router.mjs";

const unavailable = { error: { type: "server_error", message: "Upstream request failed: Endpoint is unavailable." } };
const failure = (headers = {}, status = 429) => Response.json(unavailable, { status, headers });

test("retries endpoint unavailability once with identical request, auth and session", async () => {
  const options = { body: "private-history", headers: { authorization: "test-auth" }, signal: new AbortController().signal };
  const calls = [];
  let retries = 0;
  const response = await fetchWithAvailabilityRetry(async (url, received) => {
    calls.push({ url, received });
    return calls.length === 1 ? failure() : Response.json({ ok: true });
  }, "http://127.0.0.1/responses", options, () => { retries += 1; });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(retries, 1);
  assert.equal(calls[0].url, calls[1].url);
  assert.equal(calls[0].received, options);
  assert.equal(calls[1].received, options);
});

test("persistent unavailability stops after two attempts and preserves final failure", async () => {
  let calls = 0;
  const response = await fetchWithAvailabilityRetry(async () => { calls += 1; return failure(); }, "test", {});
  assert.equal(calls, 2);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), unavailable);
});

test("never retries quota limits, auth failures, unknown errors or successful streams", async () => {
  for (const response of [Response.json({ error: { type: "rate_limit_exceeded", message: "Limit reached" } }, { status: 429 }),
    failure({}, 401), failure({}, 400), Response.json({ error: { message: unavailable.error.message } }, { status: 429 }),
    new Response("invalid json", { status: 503 }), new Response("x".repeat(9000), { status: 429 }),
    new Response("data: partial output\n\n", { headers: { "content-type": "text/event-stream" } })]) {
    let calls = 0;
    const expected = await response.clone().text();
    const result = await fetchWithAvailabilityRetry(async () => { calls += 1; return response; }, "test", {});
    assert.equal(calls, 1);
    assert.equal(result, response);
    assert.equal(await result.text(), expected);
  }
});

test("honors Retry-After and delegates long or malformed delays without retrying early", async () => {
  const start = performance.now();
  let calls = 0;
  await fetchWithAvailabilityRetry(async () => ++calls === 1 ? failure({ "retry-after": "1" }) : Response.json({}), "test", {});
  assert.equal(calls, 2);
  assert.ok(performance.now() - start >= 990);
  for (const retryAfter of ["60", new Date(Date.now() + 60000).toUTCString(), "invalid"]) {
    calls = 0;
    const response = await fetchWithAvailabilityRetry(async () => { calls += 1; return failure({ "retry-after": retryAfter }); }, "test", {});
    assert.equal(calls, 1);
    assert.equal(response.headers.get("retry-after"), retryAfter);
    assert.deepEqual(await response.json(), unavailable);
  }
});

test("disconnect during backoff aborts without another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(fetchWithAvailabilityRetry(async () => { calls += 1; return failure(); }, "test", { signal: controller.signal }), { name: "AbortError" });
    assert.equal(calls, 1);
  } finally { clearTimeout(timer); }
});

test("does not replay network exceptions after a possibly accepted POST", async () => {
  let calls = 0;
  await assert.rejects(fetchWithAvailabilityRetry(async () => { calls += 1; throw new Error("network lost"); }, "test", {}), /network lost/);
  assert.equal(calls, 1);
});

test("inspection timeout never retries an unfinished error body", async () => {
  let calls = 0;
  let source;
  const response = new Response(new ReadableStream({ start(controller) {
    source = controller;
    controller.enqueue(new TextEncoder().encode(JSON.stringify(unavailable)));
  } }), { status: 429 });
  const result = await fetchWithAvailabilityRetry(async () => { calls += 1; return response; }, "test", {});
  assert.equal(calls, 1);
  assert.equal(result, response);
  source.close();
  assert.deepEqual(await result.json(), unavailable);
});
