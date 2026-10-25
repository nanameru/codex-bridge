/** Durable, secret-free provider limit tracking for the DeepSeek fallback chain. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const AUTO_DEEPSEEK_PROVIDERS = Object.freeze(["opencode", "commandcode", "ollama"]);
export const ALL_FALLBACK_PROVIDERS = Object.freeze(["whatstoken", ...AUTO_DEEPSEEK_PROVIDERS]);
export const AUTO_DEEPSEEK_MODEL = "deepseek-v4.1-flash";
export const PROVIDER_STATE_VERSION = 1;
const WINDOWS = new Set(["short", "weekly", "monthly", "unknown"]);
const MAX_STATE_BYTES = 64 * 1024;
const MAX_RESET_AHEAD_MS = 370 * 24 * 60 * 60 * 1000;

function boundedBoolean(value) {
  return typeof value === "boolean" ? value : undefined;
}

function headerObject(headers) {
  const result = {};
  for (const [name, value] of headers) result[name.toLowerCase()] = value;
  return result;
}

async function readFailurePayload(response, maxBytes = 32768) {
  if (!response.body) return null;
  const reader = response.clone().body.getReader();
  const chunks = [];
  let size = 0;
  let timeout;
  const deadline = new Promise(resolve => { timeout = setTimeout(() => resolve({ done: true, timedOut: true }), 1000); });
  try {
    for (;;) {
      const { done, value, timedOut } = await Promise.race([reader.read(), deadline]);
      if (timedOut) return null;
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(Buffer.from(value));
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    const data = text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim())
      .find(line => line && line !== "[DONE]");
    if (!data) return null;
    try {
      const parsed = JSON.parse(data);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }
}

function errorObject(payload) {
  if (!payload) return {};
  if (payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)) return payload.error;
  return typeof payload.error === "string" ? { message: payload.error } : payload;
}

function safeText(value, max = 2048) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function searchableFailure(error, payload, headers) {
  const fields = [
    error.code, error.type, error.message, error.detail, error.window, error.period, error.limit,
    error.limit_id, error.limit_name, error.reset, error.resets_at, error.reset_at,
    payload?.code, payload?.message, payload?.type, payload?.window, payload?.period,
  ].map(value => safeText(value));
  for (const [name, value] of Object.entries(headers)) {
    if (/^(?:retry-after|x-ratelimit|x-rate-limit)/i.test(name)) fields.push(name, safeText(value, 256));
  }
  return fields.filter(Boolean).join(" ").toLowerCase();
}

const STRONG_QUOTA_CODES = new Set([
  "billing_hard_limit_reached", "credit_balance_too_low", "credits_exhausted", "insufficient_credits",
  "insufficient_quota", "monthly_limit_exceeded", "quota_exceeded", "usage_exceeded",
  "weekly_limit_exceeded",
]);

function hasQuotaSignal(status, error, text, headers) {
  if (status === 402) return true;
  if (status !== 429) return false;
  const code = safeText(error.code, 128).toLowerCase();
  const type = safeText(error.type, 128).toLowerCase();
  if (STRONG_QUOTA_CODES.has(code) || STRONG_QUOTA_CODES.has(type)) return true;
  if (/(?:per[- ](?:minute|second)|concurren|requests?\/(?:min|sec)|tokens?\/(?:min|sec))/.test(text)
      && !/(?:5[- ]?hour|weekly|monthly|quota|credits? (?:exhausted|balance))/.test(text)) return false;
  if (/(?:usage|quota|credit|allowance|billing|subscription|plan)[^.]{0,100}(?:exceed|reach|exhaust|run out|unavailable|zero|reset)/
    .test(text)) return true;
  if (/(?:exceed|reach|exhaust|run out)[^.]{0,100}(?:usage|quota|credit|allowance|billing cycle|billing window)/
    .test(text)) return true;
  if (/(?:5[- ]?hour|five[- ]hour|weekly|7[- ]day|monthly|billing cycle|billing window)[^.]{0,100}(?:limit|reset|exceed|reach)/
    .test(text)) return true;
  const remaining = headers["x-ratelimit-remaining"] ?? headers["x-rate-limit-remaining"];
  const window = headers["x-ratelimit-limit"] ?? headers["x-rate-limit-limit"];
  return remaining === "0" && /(?:5h|hour|week|month|day)/i.test(window ?? "");
}

function classifyWindow(error, text) {
  for (const value of [error.window, error.period, error.limit_id, error.limit_name, text]) {
    const label = safeText(value).toLowerCase();
    if (/(?:month|billing cycle|billing window)/.test(label)) return "monthly";
    if (/(?:week|7[- ]?day)/.test(label)) return "weekly";
    if (/(?:5[- ]?hour|five[- ]?hour|session|rolling|^short$)/.test(label)) return "short";
  }
  return "unknown";
}

function durationMs(value) {
  if (typeof value !== "string") return null;
  let total = 0;
  let found = false;
  const pattern = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s|日|時間|分|秒)/gi;
  for (const match of value.matchAll(pattern)) {
    found = true;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (!Number.isFinite(amount)) return null;
    const multiplier = unit === "d" || unit.startsWith("day") || unit === "日" ? 86400000
      : unit === "h" || unit.startsWith("hour") || unit.startsWith("hr") || unit === "時間" ? 3600000
        : unit === "m" || unit.startsWith("min") || unit === "分" ? 60000 : 1000;
    total += amount * multiplier;
  }
  return found && Number.isFinite(total) && total > 0 ? Math.round(total) : null;
}

function timestampMs(value, now) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const candidate = value > 1e12 ? value : value * 1000;
    return candidate > now ? candidate : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  check: {
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      const candidate = numeric >= 1e12 ? numeric : numeric >= 1e9 ? numeric * 1000 : now + numeric * 1000;
      if (candidate > now) return candidate;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed > now) return parsed;
    const duration = durationMs(trimmed);
    if (duration) return now + duration;
    break check;
  }
  return null;
}

function resetFromPayload(error, payload, headers, text, now) {
  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const parsed = timestampMs(retryAfter, now);
    if (parsed) return parsed;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (/^x-(?:rate-limit|ratelimit)-reset(?:-|$)/i.test(name)) {
      const parsed = timestampMs(value, now);
      if (parsed) return parsed;
    }
  }
  const candidates = [
    error.resets_at, error.reset_at, error.reset_time, error.reset,
    payload?.resets_at, payload?.reset_at, payload?.reset,
  ];
  for (const value of candidates) {
    const parsed = timestampMs(value, now);
    if (parsed) return parsed;
  }
  const resetMatch = text.match(/(?:reset(?:s|ting)?(?:\s+in|\s+at)?|retry after)\s*:?\s*([^.;\n]+)/i);
  if (resetMatch) {
    const parsed = timestampMs(resetMatch[1], now);
    if (parsed) return parsed;
  }
  const iso = text.match(/\b(20\d{2}-\d{2}-\d{2}t\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2}))\b/i);
  if (iso) {
    const parsed = Date.parse(iso[1]);
    if (Number.isFinite(parsed) && parsed > now) return parsed;
  }
  return null;
}

export async function classifyProviderLimit(response, { now = Date.now(), unknownCooldownMs = 300000 } = {}) {
  if (!response || ![402, 429].includes(response.status)) return null;
  const headers = headerObject(response.headers);
  const payload = await readFailurePayload(response);
  const error = errorObject(payload);
  const text = searchableFailure(error, payload, headers);
  if (!hasQuotaSignal(response.status, error, text, headers)) return null;
  const window = classifyWindow(error, text);
  const parsedReset = resetFromPayload(error, payload, headers, text, now);
  const resetAt = parsedReset > now && parsedReset <= now + MAX_RESET_AHEAD_MS ? parsedReset : null;
  const code = `http_${response.status}`;
  return Object.freeze({
    providerLimited: true,
    status: response.status,
    window: WINDOWS.has(window) ? window : "unknown",
    code,
    resetAt: resetAt ?? now + Math.min(MAX_RESET_AHEAD_MS, Math.max(1000, Number(unknownCooldownMs) || 300000)),
    resetKnown: resetAt !== null && error.reset_known !== false,
  });
}

// Separate from quota exhaustion: this short-lived state must never be written
// to the durable subscription-window file. The bridge's own guard stays local.
export async function classifyTransientProviderLimit(response, { now = Date.now() } = {}) {
  if (response?.status !== 429) return null;
  const payload = await readFailurePayload(response);
  const error = errorObject(payload);
  if (safeText(error.message).startsWith("codex-bridge:")) return null;
  const headers = headerObject(response.headers);
  if (hasQuotaSignal(response.status, error, searchableFailure(error, payload, headers), headers)) return null;
  const retry = response.headers.get("retry-after")?.trim();
  let waitMs = 30000;
  if (/^\d{1,6}$/.test(retry ?? "")) waitMs = Number(retry) * 1000;
  else if (retry && retry.length <= 128 && Number.isFinite(Date.parse(retry))) waitMs = Date.parse(retry) - now;
  return { transientLimited: true, resetAt: now + Math.min(300000, Math.max(1000, waitMs)) };
}

function validEntry(entry) {
  return entry && typeof entry === "object" && !Array.isArray(entry)
    && Number.isSafeInteger(entry.until) && entry.until > 0
    && ["http_402", "http_429"].includes(entry.reason);
}

function parseState(raw) {
  if (!raw || raw.version !== PROVIDER_STATE_VERSION || !raw.providers
      || typeof raw.providers !== "object" || Array.isArray(raw.providers)) return { version: PROVIDER_STATE_VERSION, providers: {} };
  const providers = {};
  for (const provider of ALL_FALLBACK_PROVIDERS) {
    const windows = raw.providers[provider]?.windows;
    if (!windows || typeof windows !== "object" || Array.isArray(windows)) continue;
    const clean = {};
    for (const window of WINDOWS) if (validEntry(windows[window])) clean[window] = {
      until: windows[window].until,
      reason: windows[window].reason,
      ...(boundedBoolean(windows[window].reset_known) !== undefined ? { reset_known: windows[window].reset_known } : {}),
    };
    if (Object.keys(clean).length) providers[provider] = { windows: clean };
  }
  return { version: PROVIDER_STATE_VERSION, providers };
}

function privateDirectory(path) {
  if (typeof process.getuid !== "function") return false;
  try {
    const info = lstatSync(path);
    return info.isDirectory() && info.uid === process.getuid() && !(info.mode & 0o022);
  } catch { return false; }
}

function readStateFile(file) {
  const directory = dirname(file);
  if (!privateDirectory(directory)) return { version: PROVIDER_STATE_VERSION, providers: {} };
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.nlink !== 1
        || info.size > MAX_STATE_BYTES) return { version: PROVIDER_STATE_VERSION, providers: {} };
    return parseState(JSON.parse(readFileSync(descriptor, "utf8")));
  } catch {
    return { version: PROVIDER_STATE_VERSION, providers: {} };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function atomicWriteState(file, state) {
  const directory = dirname(file);
  if (!privateDirectory(directory)) throw new Error("provider_state_directory_insecure");
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.nlink !== 1)
      throw new Error("provider_state_file_insecure");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temp = join(directory, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const serialized = JSON.stringify(state, null, 2) + "\n";
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new Error("provider_state_too_large");
    writeSync(descriptor, serialized);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temp, file);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}

export class ProviderFallbackState {
  constructor({ file, now = () => Date.now(), unknownCooldownMs = 300000 } = {}) {
    this.file = file;
    this.now = now;
    this.unknownCooldownMs = unknownCooldownMs;
    this.transient = new Map();
    this.state = file ? readStateFile(file) : { version: PROVIDER_STATE_VERSION, providers: {} };
  }

  #prune(provider) {
    if (this.transient.get(provider) <= this.now()) this.transient.delete(provider);
    const entry = this.state.providers[provider];
    if (!entry) return;
    const now = this.now();
    for (const window of WINDOWS) {
      if (entry.windows[window]?.until <= now || entry.windows[window]?.until > now + MAX_RESET_AHEAD_MS) delete entry.windows[window];
    }
    if (!Object.keys(entry.windows).length) delete this.state.providers[provider];
  }

  #save() {
    if (this.file) atomicWriteState(this.file, this.state);
  }

  available(provider) {
    this.#prune(provider);
    return !this.state.providers[provider] && !this.transient.has(provider);
  }

  candidates(order = AUTO_DEEPSEEK_PROVIDERS) {
    return order.filter(provider => this.available(provider));
  }

  recordLimit(provider, result) {
    if (!ALL_FALLBACK_PROVIDERS.includes(provider) || !result?.providerLimited) throw new Error("provider_limit_invalid");
    const window = WINDOWS.has(result.window) ? result.window : "unknown";
    const now = this.now();
    const until = Number.isSafeInteger(result.resetAt) && result.resetAt > now && result.resetAt <= now + MAX_RESET_AHEAD_MS
      ? result.resetAt : now + this.unknownCooldownMs;
    const entry = this.state.providers[provider] ??= { windows: {} };
    const previous = entry.windows[window];
    entry.windows[window] = {
      until: previous ? Math.max(previous.until, until) : until,
      reason: result.status === 402 ? "http_402" : "http_429",
      reset_known: Boolean(result.resetKnown),
    };
    this.#save();
    return this.snapshot(provider);
  }

  recordTransient(provider, result) {
    if (!ALL_FALLBACK_PROVIDERS.includes(provider) || !result?.transientLimited || !Number.isSafeInteger(result.resetAt))
      throw new Error("provider_transient_limit_invalid");
    const now = this.now();
    this.transient.set(provider, Math.max(this.transient.get(provider) ?? 0,
      now + Math.min(300000, Math.max(1000, result.resetAt - now))));
    return this.snapshot(provider);
  }

  recordSuccess(provider) {
    return this.available(provider) ? null : this.snapshot(provider);
  }

  nextResetAt(provider) {
    this.#prune(provider);
    const windows = Object.values(this.state.providers[provider]?.windows ?? {});
    if (this.transient.has(provider)) windows.push({ until: this.transient.get(provider) });
    return windows.length ? Math.min(...windows.map(window => window.until)) : null;
  }

  unblockAt(provider) {
    this.#prune(provider);
    const windows = Object.values(this.state.providers[provider]?.windows ?? {});
    if (this.transient.has(provider)) windows.push({ until: this.transient.get(provider) });
    return windows.length ? Math.max(...windows.map(window => window.until)) : null;
  }

  earliestUnblockAt(order = AUTO_DEEPSEEK_PROVIDERS) {
    const resets = order.map(provider => this.unblockAt(provider)).filter(Number.isSafeInteger);
    return resets.length ? Math.min(...resets) : null;
  }

  snapshot(provider) {
    this.#prune(provider);
    const entry = this.state.providers[provider];
    const transientUntil = this.transient.get(provider);
    return { provider, available: !entry && !transientUntil, windows: structuredClone(entry?.windows ?? {}),
      ...(transientUntil ? { transientUntil } : {}) };
  }
}
