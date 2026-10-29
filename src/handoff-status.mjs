import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { TOOL_SEARCH_REASON_CODES } from "./tool-search.mjs";

const active = new WeakMap();
const ITEM_PREFIX = "msg_bridge_handoff_";
const PROGRESS_PREFIX = "rs_bridge_handoff_";
export const WAIT_TEXT = "履歴を変換中（bridge）";
export const BUDGET_TEXT = "会話履歴を要約中（bridge）";
const READY_TEXT = "\n履歴変換完了";

export function isHandoffStatusItem(item) {
  return typeof item?.id === "string" && (
    (item.type === "message" && item.role === "assistant" && item.phase === "commentary" && item.id.startsWith(ITEM_PREFIX))
    || (item.type === "reasoning" && item.id.startsWith(PROGRESS_PREFIX)));
}

// Only used after authenticated requests actually wait for a cache miss/shared job.
export class HandoffStatus {
  constructor(response, { model, enabled, delayMs = 1000 }) {
    this.response = response;
    this.model = model;
    this.enabled = enabled;
    this.delayMs = delayMs;
    this.sequence = 0;
    this.started = false;
    this.finished = false;
    this.terminal = false;
    this.id = "resp_bridge_handoff_" + randomUUID();
    this.itemId = PROGRESS_PREFIX + randomUUID();
  }
  observe(cache, reason = "handoff") {
    if (!this.enabled || !["miss", "shared"].includes(cache) || this.timer || this.started) return;
    this.reason = reason;
    this.shared = cache === "shared";
    this.timer = setTimeout(() => this.begin(), this.delayMs);
    this.timer.unref?.();
  }
  envelope(status, output = []) {
    return { id: this.id, object: "response", created_at: Math.floor(Date.now() / 1000),
      model: this.model, status, output, error: null };
  }
  item(status = "completed") {
    // Codex derives its live Working heading from reasoning-summary deltas.
    // This is explicitly bridge progress, not model-generated reasoning.
    return { id: this.itemId, type: "reasoning", status,
      summary: [{ type: "summary_text", text: this.text }] };
  }
  frame(payload) {
    return `event: ${payload.type}\ndata: ${JSON.stringify({ ...payload, sequence_number: this.sequence++ })}\n\n`;
  }
  emit(payload) {
    if (!this.response.destroyed && !this.response.writableEnded) this.response.write(this.frame(payload));
  }
  begin() {
    if (this.started || this.response.destroyed || this.response.writableEnded) return;
    this.started = true;
    this.text = this.reason === "budget" ? BUDGET_TEXT : WAIT_TEXT;
    if (this.shared) this.text += "・共有処理の完了待ち";
    active.set(this.response, this);
    this.response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
    this.response.flushHeaders();
    this.emit({ type: "response.created", response: this.envelope("in_progress") });
    this.emit({ type: "response.output_item.added", output_index: 0,
      item: { ...this.item("in_progress"), summary: [] } });
    this.emit({ type: "response.reasoning_summary_part.added", item_id: this.itemId, output_index: 0, summary_index: 0,
      part: { type: "summary_text", text: "" } });
    this.emit({ type: "response.reasoning_summary_text.delta", item_id: this.itemId, output_index: 0, summary_index: 0, delta: this.text });
  }
  ready() { this.finish(this.reason === "budget" ? "\n要約完了" : READY_TEXT, "\nWorking"); }
  finish(suffix, heading) {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.started || this.finished) return;
    this.finished = true;
    this.text += suffix;
    this.emit({ type: "response.reasoning_summary_text.delta", item_id: this.itemId, output_index: 0, summary_index: 0, delta: suffix });
    // Codex retains the last summary heading across tools and empty reasoning.
    // Keep completion in the transcript, then restore its normal Working label.
    if (heading) {
      this.text += heading;
      this.emit({ type: "response.reasoning_summary_text.delta", item_id: this.itemId, output_index: 0, summary_index: 0, delta: heading });
    }
    this.emit({ type: "response.reasoning_summary_text.done", item_id: this.itemId, output_index: 0, summary_index: 0, text: this.text });
    this.emit({ type: "response.reasoning_summary_part.done", item_id: this.itemId, output_index: 0, summary_index: 0, part: this.item().summary[0] });
    this.emit({ type: "response.output_item.done", output_index: 0, item: this.item() });
  }
  fail(status, code, message) {
    if (!this.started || this.terminal || this.response.destroyed || this.response.writableEnded) return false;
    this.finish("\n処理に失敗しました。元の会話履歴を保持して停止しました。");
    this.terminal = true;
    const errorCode = code === "compaction_handoff_failed" || [400, 413, 422].includes(status)
      ? "invalid_prompt" : status === 429 ? "rate_limit_exceeded" : "server_error";
    this.emit({ type: "response.failed", response: { ...this.envelope("failed", [this.item()]),
      error: { code: errorCode, message: `${code} (HTTP ${status}): ${message}` } } });
    this.response.end();
    return true;
  }
  stream(contentType, maxBytes) {
    const owner = this;
    const decoder = new TextDecoder();
    const isSse = contentType.includes("text/event-stream");
    let buffer = "";
    const convert = (payload) => {
      if (owner.terminal || payload.type === "response.created") return "";
      const event = { ...payload };
      if (Number.isInteger(event.output_index)) event.output_index++;
      if (event.response_id) event.response_id = owner.id;
      if (event.response) {
        event.response = { ...event.response, id: owner.id };
        if (Array.isArray(event.response.output)) event.response.output = [owner.item(), ...event.response.output];
      }
      if (["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type)) owner.terminal = true;
      return owner.frame(event);
    };
    const parseFrame = (frame) => {
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n").trim();
      if (!data || data === "[DONE]") return "";
      return convert(JSON.parse(data));
    };
    return new Transform({
      transform(chunk, _encoding, callback) {
        try {
          buffer += decoder.decode(chunk, { stream: true });
          if (isSse) {
            let boundary;
            while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
              const frame = buffer.slice(0, boundary.index);
              if (Buffer.byteLength(frame) > maxBytes) throw new Error("upstream event too large");
              this.push(parseFrame(frame));
              buffer = buffer.slice(boundary.index + boundary[0].length);
            }
          }
          if (Buffer.byteLength(buffer) > maxBytes) throw new Error("upstream event too large");
          callback();
        } catch (error) { callback(error); }
      },
      flush(callback) {
        try {
          buffer += decoder.decode();
          if (Buffer.byteLength(buffer) > maxBytes) throw new Error("upstream event too large");
          if (buffer.trim()) {
            if (isSse) this.push(parseFrame(buffer));
            else {
              const result = JSON.parse(buffer);
              if (result.status !== "completed" || !Array.isArray(result.output)) throw new Error("incomplete upstream response");
              result.output.forEach((item, index) => {
                this.push(convert({ type: "response.output_item.added", output_index: index, item }));
                this.push(convert({ type: "response.output_item.done", output_index: index, item }));
              });
              this.push(convert({ type: "response.completed", response: result }));
            }
          }
          if (!owner.terminal) throw new Error("upstream stream did not complete");
          callback();
        } catch (error) { callback(error); }
      },
    });
  }
  dispose() { clearTimeout(this.timer); active.delete(this.response); }
}

export function failHandoffStatus(response, status, code, message) {
  return active.get(response)?.fail(status, code, message) ?? false;
}

// Never forward raw upstream messages: they can echo credentials or user input.
const SAFE_UPSTREAM_CODES = new Set(["invalid_request_error", "invalid_prompt", "context_length_exceeded",
  "invalid_image", "invalid_image_format", "invalid_base64_image", "invalid_image_url", "image_too_large",
  "failed_to_download_image", "unsupported_parameter", "unsupported_value", "model_not_found",
  "rate_limit_exceeded", "insufficient_quota", "usage_exceeded", "quota_exceeded", "insufficient_credits",
  "credits_exhausted", "billing_hard_limit_reached", "monthly_limit_exceeded", "weekly_limit_exceeded",
  "authentication_error", "permission_error", "server_error",
  "content_filter", "invalid_api_key", "not_found_error", "overloaded_error", "invalid_tool_history",
  "chat_history_conversion_failed", "invalid_output_limit", "invalid_reasoning_options", "invalid_chat_messages",
  "request_too_large", ...TOOL_SEARCH_REASON_CODES]);
export async function readUpstreamFailure(response, { maxBytes = 16384, timeoutMs = 1000 } = {}) {
  const reader = response.body.getReader();
  let timer;
  const fallback = read => ({ code: "unknown_error", type: "unknown_error", read });
  try {
    const readBody = async () => {
      const chunks = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) return fallback("too_large");
        chunks.push(Buffer.from(value));
      }
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return fallback("invalid_json"); }
      // Gateways also return {error: "..."}, {message: "..."}, or
      // FastAPI-style {detail: ...}. Never expose any of those raw values.
      const error = parsed?.error && typeof parsed.error === 'object' ? parsed.error : parsed;
      const safe = value => SAFE_UPSTREAM_CODES.has(value) ? value : "unknown_error";
      let code = safe(error?.code);
      // Only emit fixed categories; never a substring from the upstream message.
      const message = typeof parsed?.error === 'string' ? parsed.error
        : typeof error?.message === 'string' ? error.message
        : typeof parsed?.detail === 'string' ? parsed.detail : '';
      if (["unknown_error", "invalid_request_error", "invalid_prompt"].includes(code) && message) {
        for (const [pattern, category] of [
          [/context (?:length|window)|maximum context|too many tokens/i, "context_length_exceeded"],
          [/(?:request|body|payload).{0,40}(?:too large|size.{0,15}(?:limit|exceed))|maximum.{0,20}(?:body|payload) size/i, "request_too_large"],
          [/image.{0,30}(?:invalid|unsupported)|(?:invalid|unsupported).{0,30}image/i, "invalid_image"],
          [/(?:max_tokens|max_completion_tokens|max_output_tokens).{0,100}(?:invalid|must|maximum|limit|exceed|range)|(?:invalid|unsupported).{0,40}(?:max_tokens|max_output_tokens)/i, "invalid_output_limit"],
          [/(?:thinking|reasoning_effort).{0,60}(?:invalid|unsupported|must)|(?:invalid|unsupported).{0,40}(?:thinking|reasoning_effort)/i, "invalid_reasoning_options"],
          [/(?:tool|function).{0,30}(?:schema|parameters|definition|name).{0,60}(?:invalid|unsupported|must|maximum|limit)|(?:invalid|unsupported).{0,30}(?:tool|function).{0,30}(?:schema|parameters|definition|name)/i, "invalid_tool_definition"],
          [/tool_call_id|tool (?:call|result)|function (?:call|response)/i, "invalid_tool_history"],
          [/(?:messages|role).{0,40}(?:invalid|unsupported|must)|(?:invalid|unsupported).{0,30}(?:messages|role)/i, "invalid_chat_messages"],
        ]) if (pattern.test(message)) { code = category; break; }
      }
      return { code, type: safe(error?.upstream_error_type ?? error?.type), read: "parsed" };
    };
    return await Promise.race([readBody(), new Promise(resolve => {
      timer = setTimeout(() => resolve(fallback("timeout")), timeoutMs);
    })]);
  } catch { return fallback("read_failed"); }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
