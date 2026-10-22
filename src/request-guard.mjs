/**
 * スレッド単位の暴走ガード。
 *
 * 1本の配列を全スレッドで共有すると、同時に使っている別チャットの合計が
 * 上限に達しただけで全チャットが429になる。ここでは会話スレッドごとに
 * 直近1分の通過数を数え、拒否したリクエストは数えない。
 */

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_TRACKED_THREADS = 1024;

function assertNumber(name, value, min) {
  if (!Number.isFinite(value) || value < min) {
    throw new TypeError(`${name} must be a finite number >= ${min}`);
  }
}

export function createRequestGuard({
  maxPerThread = 40,
  maxGlobal = 0,
  windowMs = DEFAULT_WINDOW_MS,
  maxTrackedThreads = DEFAULT_MAX_TRACKED_THREADS,
  now = Date.now,
} = {}) {
  assertNumber("maxPerThread", maxPerThread, 1);
  assertNumber("maxGlobal", maxGlobal, 0);
  assertNumber("windowMs", windowMs, 1);
  assertNumber("maxTrackedThreads", maxTrackedThreads, 1);
  if (typeof now !== "function") throw new TypeError("now must be a function");

  /** @type {Map<string, number[]>} 古い順に並ぶ通過時刻。参照順=LRU。 */
  const threads = new Map();
  const globalHits = [];

  function prune(hits, at) {
    while (hits.length && at - hits[0] >= windowMs) hits.shift();
    return hits;
  }

  function deny(scope, limit, hits, at) {
    return {
      allowed: false,
      scope,
      count: hits.length,
      limit,
      retryAfterSeconds: Math.max(1, Math.ceil((hits[0] + windowMs - at) / 1000)),
    };
  }

  function evict(activeKey) {
    while (threads.size > maxTrackedThreads) {
      const oldest = threads.keys().next().value;
      if (oldest === activeKey) return;
      threads.delete(oldest);
    }
  }

  return {
    check(threadId) {
      const at = now();
      const key = typeof threadId === "string" && threadId ? threadId : "unknown";

      let hits = threads.get(key);
      if (hits) threads.delete(key);
      else hits = [];
      prune(hits, at);
      threads.set(key, hits);

      if (hits.length >= maxPerThread) return deny("thread", maxPerThread, hits, at);

      if (maxGlobal > 0) {
        prune(globalHits, at);
        if (globalHits.length >= maxGlobal) return deny("global", maxGlobal, globalHits, at);
      }

      hits.push(at);
      if (maxGlobal > 0) globalHits.push(at);
      evict(key);

      return { allowed: true, scope: null, count: hits.length, limit: maxPerThread, retryAfterSeconds: 0 };
    },
    get trackedThreads() {
      return threads.size;
    },
  };
}
