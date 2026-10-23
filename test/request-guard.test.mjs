import assert from "node:assert/strict";
import test from "node:test";

import { createRequestGuard } from "../src/request-guard.mjs";

function fakeClock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; return at; } };
}

test("上限はスレッドごとに独立して数える", () => {
  const clock = fakeClock();
  const guard = createRequestGuard({ maxPerThread: 2, now: clock.now });

  assert.equal(guard.check("chat-A").allowed, true);
  assert.equal(guard.check("chat-A").allowed, true);
  const denied = guard.check("chat-A");
  assert.equal(denied.allowed, false);
  assert.equal(denied.scope, "thread");
  assert.equal(denied.count, 2);
  assert.equal(denied.limit, 2);

  // 別スレッドは影響を受けない
  assert.equal(guard.check("chat-B").allowed, true);
  assert.equal(guard.check("chat-B").allowed, true);
  assert.equal(guard.check("chat-B").allowed, false);
});

test("429 の再試行秒数は最も古い記録が窓から外れるまでを返す", () => {
  const clock = fakeClock();
  const guard = createRequestGuard({ maxPerThread: 2, windowMs: 60_000, now: clock.now });

  guard.check("chat-A");
  clock.advance(15_000);
  guard.check("chat-A");
  clock.advance(30_000);

  const denied = guard.check("chat-A");
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterSeconds, 15);
});

test("拒否したリクエストは数えず、窓が明ければ再び通る", () => {
  const clock = fakeClock();
  const guard = createRequestGuard({ maxPerThread: 1, windowMs: 60_000, now: clock.now });

  assert.equal(guard.check("chat-A").allowed, true);
  for (let i = 0; i < 10; i += 1) {
    clock.advance(1_000);
    const denied = guard.check("chat-A");
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterSeconds, 60 - (i + 1));
  }

  clock.advance(50_000);
  assert.equal(guard.check("chat-A").allowed, true);
});

test("全体上限は設定したときだけ効く", () => {
  const clock = fakeClock();
  const disabled = createRequestGuard({ maxPerThread: 1, now: clock.now });
  assert.equal(disabled.check("chat-A").allowed, true);
  assert.equal(disabled.check("chat-B").allowed, true);

  const guard = createRequestGuard({ maxPerThread: 1, maxGlobal: 2, now: clock.now });
  assert.equal(guard.check("chat-A").allowed, true);
  assert.equal(guard.check("chat-B").allowed, true);
  const denied = guard.check("chat-C");
  assert.equal(denied.allowed, false);
  assert.equal(denied.scope, "global");
  assert.equal(denied.limit, 2);
});

test("スレッドIDが無いリクエストは unknown でまとめる", () => {
  const clock = fakeClock();
  const guard = createRequestGuard({ maxPerThread: 1, now: clock.now });

  assert.equal(guard.check(undefined).allowed, true);
  assert.equal(guard.check(null).allowed, false);
  assert.equal(guard.check("").allowed, false);
});

test("追跡スレッド数は上限を超えず、古いものから捨てる", () => {
  const clock = fakeClock();
  const guard = createRequestGuard({ maxPerThread: 1, maxTrackedThreads: 2, now: clock.now });

  guard.check("chat-A");
  guard.check("chat-B");
  guard.check("chat-C");

  assert.equal(guard.trackedThreads, 2);
  assert.equal(guard.check("chat-C").allowed, false);
  assert.equal(guard.check("chat-A").allowed, true);
});

test("窓の境界ちょうどで記録は外れる", () => {
  const clock = fakeClock();
  const guard = createRequestGuard({ maxPerThread: 1, windowMs: 60_000, now: clock.now });

  guard.check("chat-A");
  clock.advance(59_999);
  assert.equal(guard.check("chat-A").allowed, false);
  clock.advance(1);
  assert.equal(guard.check("chat-A").allowed, true);
});

test("不正な設定は起動時に拒否する", () => {
  assert.throws(() => createRequestGuard({ maxPerThread: 0 }), TypeError);
  assert.throws(() => createRequestGuard({ maxPerThread: Number.NaN }), TypeError);
  assert.throws(() => createRequestGuard({ maxGlobal: -1 }), TypeError);
  assert.throws(() => createRequestGuard({ windowMs: 0 }), TypeError);
  assert.throws(() => createRequestGuard({ now: 1 }), TypeError);
});
