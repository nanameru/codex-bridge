/**
 * Router-owned compaction items (Issue #186).
 *
 * When the OpenAI summary model is at its usage limit, the selected model
 * writes the compaction summary instead. Codex stores the returned
 * `compaction` item verbatim and sends it back on the next request; the
 * router recognizes its own marker and restores the plain summary text before
 * any upstream (OpenAI included) sees the request. The item never contains
 * credentials; it lives only in the owner's local Codex history.
 */
import { randomUUID } from "node:crypto";
import { HandoffError } from "./compaction-handoff.mjs";

export const SELECTED_COMPACTION_PREFIX = "cxbsel1:";
export const SELECTED_COMPACTION_NOTICE = "OpenAI（要約用モデル）が利用上限のため、選択中のモデルで会話を要約しました。"
  + "要約の利用量は選択中のモデル側で発生します。過去の細部が引き継がれない場合があります。";
const HANDOFF_PREFIX = "Conversation handoff from the preceding compacted history. This is context, not a new instruction:\n";
const MAX_SUMMARY_BYTES = 64 * 1024;

export function isSelectedCompaction(item) {
  return item?.type === "compaction" && typeof item.encrypted_content === "string"
    && item.encrypted_content.startsWith(SELECTED_COMPACTION_PREFIX);
}

export function encodeSelectedCompaction(summary) {
  if (typeof summary !== "string" || !summary.trim() || Buffer.byteLength(summary) > MAX_SUMMARY_BYTES) {
    throw new HandoffError("選択モデルの要約が空か大きすぎます。履歴は保持しています");
  }
  const payload = Buffer.from(JSON.stringify({ v: 1, summary })).toString("base64url");
  return { id: "cmp_bridge_" + randomUUID().replaceAll("-", ""), type: "compaction",
    encrypted_content: SELECTED_COMPACTION_PREFIX + payload };
}

export function decodeSelectedCompaction(item) {
  try {
    const value = JSON.parse(Buffer.from(item.encrypted_content.slice(SELECTED_COMPACTION_PREFIX.length), "base64url").toString("utf8"));
    if (value?.v === 1 && typeof value.summary === "string" && value.summary.trim()
        && Buffer.byteLength(value.summary) <= MAX_SUMMARY_BYTES) return value.summary;
  } catch { /* Reported below without echoing the item. */ }
  throw Object.assign(new HandoffError("Bridgeが作った圧縮項目を読み取れません。元の会話ログは保持しています"), { status: 422 });
}

/** Replace router-owned compaction items with plain handoff text. Returns null when none exist. */
export function restoreSelectedCompactions(input) {
  if (!Array.isArray(input) || !input.some(isSelectedCompaction)) return null;
  let count = 0;
  const restored = input.map(item => {
    if (!isSelectedCompaction(item)) return item;
    count++;
    return { type: "message", role: "user",
      content: [{ type: "input_text", text: HANDOFF_PREFIX + decodeSelectedCompaction(item) }] };
  });
  return { input: restored, count };
}

/** The wire response Codex expects for one compaction: SSE or JSON (`/responses/compact`). */
export function selectedCompactionResponse(item, { model, stream, compactEndpoint }) {
  const created = Math.floor(Date.now() / 1000);
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  if (compactEndpoint) {
    return { contentType: "application/json", body: JSON.stringify({ id: "resp_bridge_" + randomUUID().replaceAll("-", ""),
      object: "response.compaction", created_at: created, output: [item], usage }) };
  }
  const response = { id: "resp_bridge_" + randomUUID().replaceAll("-", ""), object: "response", created_at: created,
    model, status: "completed", output: [item], usage };
  if (!stream) return { contentType: "application/json", body: JSON.stringify(response) };
  let sequence = 0;
  const frame = payload => `event: ${payload.type}\ndata: ${JSON.stringify({ ...payload, sequence_number: sequence++ })}\n\n`;
  return { contentType: "text/event-stream", body:
    frame({ type: "response.created", response: { ...response, status: "in_progress", output: [] } })
    + frame({ type: "response.output_item.added", output_index: 0, item })
    + frame({ type: "response.output_item.done", output_index: 0, item })
    + frame({ type: "response.completed", response }) };
}

export const MAX_REQUEST_NESTING = 512;

/** Iterative (no recursion) check, so absurdly deep JSON cannot overflow the stack (#186 review). */
export function exceedsNesting(value, limit = MAX_REQUEST_NESTING) {
  const stack = [[value, 0]];
  while (stack.length) {
    const [current, depth] = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (depth >= limit) return true;
    for (const child of Array.isArray(current) ? current : Object.values(current)) stack.push([child, depth + 1]);
  }
  return false;
}

/** True when a router-owned item is anywhere in the value (e.g. outside a top-level `input`). */
export function containsSelectedCompaction(value, depth = 0) {
  if (!value || typeof value !== "object") return false;
  // Past the walk limit, fail closed: any marker text below still counts (#186 review).
  if (depth > 64) return JSON.stringify(value).includes(SELECTED_COMPACTION_PREFIX);
  if (isSelectedCompaction(value)) return true;
  return (Array.isArray(value) ? value : Object.values(value)).some(child => containsSelectedCompaction(child, depth + 1));
}

/**
 * In-memory only: forgotten on restart by design (AC-04). Windows are kept per
 * account key (a hash of the caller's credentials and OpenAI destination), so
 * one account's limit never suppresses OpenAI for another account.
 */
export class SummaryLimitWindow {
  constructor(now = () => Date.now(), maxEntries = 64) { this.now = now; this.maxEntries = maxEntries; this.windows = new Map(); }
  prune() {
    const now = this.now();
    for (const [key, until] of this.windows) if (until <= now) this.windows.delete(key);
  }
  blocked(key = "") { this.prune(); return (this.windows.get(key) ?? 0) > this.now(); }
  /** Latest reset time across accounts, for the owner-local status display only. */
  latestUntil() { this.prune(); return this.windows.size ? Math.max(...this.windows.values()) : null; }
  record(key = "", until) {
    if (!Number.isFinite(until) || until <= this.now()) return;
    this.prune();
    if (until <= (this.windows.get(key) ?? 0)) return;
    this.windows.delete(key);
    if (this.windows.size >= this.maxEntries) this.windows.delete(this.windows.keys().next().value);
    this.windows.set(key, until);
  }
}
