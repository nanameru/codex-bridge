import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ProviderFallbackState, classifyProviderLimit, classifyTransientProviderLimit } from "../src/provider-fallback.mjs";

const now = Date.parse("2026-10-25T00:00:00Z");

test('temporary 429 cooldown is bounded, honors Retry-After and never persists as quota', async () => {
  for(const [header,wait] of [[undefined,30000],['0',1000],['45',45000],['999999',300000],['invalid',30000],
    [new Date(now+60000).toUTCString(),60000]]) {
    const response=Response.json({error:{code:'rate_limit_exceeded',message:'Too many requests'}},
      {status:429,headers:header===undefined?{}:{'retry-after':header}});
    const transient=await classifyTransientProviderLimit(response,{now});
    assert.equal(transient.resetAt,now+wait);
    const file=join(mkdtempSync(join(tmpdir(),'transient-limit-')),'state.json');
    let clock=now;
    const state=new ProviderFallbackState({file,now:()=>clock});
    state.recordTransient('opencode',transient);
    assert.equal(state.available('opencode'),false);assert.deepEqual(state.snapshot('opencode').windows,{});
    assert.equal(state.earliestUnblockAt(),now+wait);
    assert.equal(new ProviderFallbackState({file,now:()=>clock}).available('opencode'),true);
    state.recordLimit('commandcode',{providerLimited:true,window:'monthly',status:402,resetAt:now+86400000});
    assert.ok(!readFileSync(file,'utf8').includes('opencode'));
    clock+=wait;assert.equal(state.available('opencode'),true);
    assert.equal(state.available('commandcode'),false);
  }
  assert.equal(await classifyTransientProviderLimit(Response.json({error:{message:'codex-bridge: protected'}},{status:429})),null);
  assert.equal(await classifyTransientProviderLimit(Response.json({},{status:503})),null);
  assert.equal(await classifyTransientProviderLimit(Response.json({error:{code:'monthly_limit_exceeded'}},{status:429})),null);
  let clock=now;
  const overlap=new ProviderFallbackState({now:()=>clock});
  overlap.recordLimit('opencode',{providerLimited:true,window:'monthly',status:429,resetAt:now+86400000});
  overlap.recordTransient('opencode',{transientLimited:true,resetAt:now+30000});
  assert.equal(overlap.nextResetAt('opencode'),now+30000);
  assert.equal(overlap.unblockAt('opencode'),now+86400000);
  clock+=30001;assert.equal(overlap.available('opencode'),false);
});

test("classifies only explicit quota exhaustion and preserves general 429", async () => {
  const quota = Response.json({ error: {
    code: "rate_limit_exceeded", message: "5-hour usage limit reached. Resets in 2h 41m",
  } }, { status: 429 });
  const parsed = await classifyProviderLimit(quota, { now, unknownCooldownMs: 60000 });
  assert.equal(parsed.providerLimited, true);
  assert.equal(parsed.window, "short");
  assert.equal(parsed.resetKnown, true);
  assert.equal(parsed.resetAt, now + (2 * 60 + 41) * 60000);

  for (const response of [
    Response.json({ error: { code: "rate_limit_exceeded", message: "Too many requests" } }, { status: 429 }),
    Response.json({ error: { code: "authentication_error", message: "invalid key" } }, { status: 401 }),
    Response.json({ error: { code: "server_error", message: "busy" } }, { status: 503 }),
    Response.json({ error: { code: "invalid_request_error", message: "bad tool" } }, { status: 400 }),
  ]) assert.equal(await classifyProviderLimit(response, { now }), null);
});

test("uses 402 and explicit usage codes as quota without trusting arbitrary 429", async () => {
  const payment = await classifyProviderLimit(Response.json({ error: { message: "payment required" } }, { status: 402 }), {
    now, unknownCooldownMs: 90000,
  });
  assert.equal(payment.providerLimited, true);
  assert.equal(payment.window, "unknown");
  assert.equal(payment.resetAt, now + 90000);
  const usage = await classifyProviderLimit(Response.json({ error: {
    code: "usage_exceeded", window: "monthly", resets_at: new Date(now + 86400000).toISOString(),
  } }, { status: 429 }), { now });
  assert.equal(usage.window, "monthly");
  assert.equal(usage.resetAt, now + 86400000);
});

test("overlapping windows keep a provider blocked until every window clears", () => {
  let clock = now;
  const state = new ProviderFallbackState({ now: () => clock, unknownCooldownMs: 60000 });
  state.recordLimit("opencode", { providerLimited: true, code: "short_limit", window: "short",
    resetAt: now + 3600000, resetKnown: true, status: 429 });
  state.recordLimit("opencode", { providerLimited: true, code: "monthly_limit", window: "monthly",
    resetAt: now + 86400000, resetKnown: true, status: 429 });
  clock = now + 3600001;
  assert.deepEqual(state.candidates(), ["commandcode", "ollama"]);
  clock = now + 86400001;
  assert.deepEqual(state.candidates(), ["opencode", "commandcode", "ollama"]);
});

test("state is private, durable and contains neither credentials nor request content", () => {
  const directory = mkdtempSync(join(tmpdir(), "provider-fallback-"));
  const file = join(directory, "provider-fallback-state.json");
  const state = new ProviderFallbackState({ file, now: () => now });
  state.recordLimit("commandcode", { providerLimited: true, code: "usage_exceeded", window: "weekly",
    resetAt: now + 604800000, resetKnown: true, status: 429 });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const text = readFileSync(file, "utf8");
  assert.match(text, /"weekly"/);
  for (const forbidden of ["Bearer", "api-key", "private conversation", "thread_id"]) assert.ok(!text.includes(forbidden));
  const restored = new ProviderFallbackState({ file, now: () => now });
  assert.deepEqual(restored.candidates(), ["opencode", "ollama"]);
});

test("invalid or permissive state is ignored safely", () => {
  const directory = mkdtempSync(join(tmpdir(), "provider-fallback-"));
  const file = join(directory, "provider-fallback-state.json");
  writeFileSync(file, JSON.stringify({ version: 1, providers: { opencode: { windows: { weekly: {
    until: "forever", reason: "secret value",
  } } } } }));
  const state = new ProviderFallbackState({ file, now: () => now });
  assert.deepEqual(state.candidates(), ["opencode", "commandcode", "ollama"]);
});

test('explicit short window wins over credit wording and arbitrary codes are never persisted', async () => {
  const result = await classifyProviderLimit(Response.json({ error: {
    code: 'secret_key_value', message: 'Your 5-hour credit usage limit reached. Resets in 1h',
  } }, { status: 429 }), { now });
  assert.equal(result.window, 'short'); assert.equal(result.code, 'http_429');
});

test('reset headers support seconds, HTTP dates, epochs and unknown future bounds', async () => {
  for (const [headers, expected] of [
    [{ 'retry-after': '60' }, now + 60000],
    [{ 'retry-after': new Date(now + 60000).toUTCString() }, now + 60000],
    [{ 'x-ratelimit-reset': String((now + 60000) / 1000) }, now + 60000],
    [{ 'x-rate-limit-reset-monthly': new Date(now + 60000).toISOString() }, now + 60000],
  ]) {
    const result = await classifyProviderLimit(Response.json({ error: { code: 'usage_exceeded' } }, { status: 429, headers }), { now });
    assert.equal(result.resetAt, expected); assert.equal(result.resetKnown, true);
  }
  const future = await classifyProviderLimit(Response.json({ error: { resets_at: '2099-01-01T00:00:00Z' } }, { status: 402 }), { now });
  assert.equal(future.resetKnown, false); assert.equal(future.resetAt, now + 300000);
  const generic = await classifyProviderLimit(Response.json({ error: { message: 'Too many requests. Resets in 1s' } }, { status: 429 }), { now });
  assert.equal(generic, null);
});

test('unfinished quota errors have a bounded read deadline', async () => {
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } }), { status: 402 });
  const start = performance.now();
  const result = await classifyProviderLimit(response, { now });
  assert.equal(result.resetKnown, false);
  assert.ok(performance.now() - start < 2000);
  await response.body.cancel();
});

test('symlink状態ファイルを上書きせずin-memoryの上限を保持する', async () => {
  const { symlinkSync, rmSync } = await import('node:fs');
  const directory = mkdtempSync(join(tmpdir(), 'provider-fallback-'));
  try {
    const target = join(directory, 'target'); writeFileSync(target, 'keep', { mode: 0o600 });
    const file = join(directory, 'state'); symlinkSync(target, file);
    const state = new ProviderFallbackState({ file, now: () => now });
    assert.throws(() => state.recordLimit('opencode', { providerLimited: true, resetAt: now + 60000 }), /insecure/);
    assert.equal(readFileSync(target, 'utf8'), 'keep');
    assert.equal(state.available('opencode'), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('planやusageを含むRPMや同時実行数の429を枯渇と誤判定しない', async () => {
  for (const message of ['Plan usage rate limit exceeded: requests per minute', 'Usage concurrency limit exceeded']) {
    assert.equal(await classifyProviderLimit(Response.json({ error: { message } }, { status: 429 }), { now }), null);
  }
});
