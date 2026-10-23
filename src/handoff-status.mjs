import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";

const active = new WeakMap();
const ITEM_PREFIX = "msg_bridge_handoff_";
export const WAIT_TEXT = "接続ステータス：OpenCodeへ切り替えるため、会話履歴を引き継いでいます。";
const READY_TEXT = "\n履歴の引き継ぎが完了しました。OpenCodeの応答を待っています。";

export function isHandoffStatusItem(item) {
  return item?.type === "message" && item.role === "assistant" && item.phase === "commentary"
    && typeof item.id === "string" && item.id.startsWith(ITEM_PREFIX);
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
    this.itemId = ITEM_PREFIX + randomUUID();
  }
  observe(cache) {
    if (!this.enabled || !["miss", "shared"].includes(cache) || this.timer || this.started) return;
    this.timer = setTimeout(() => this.begin(), this.delayMs);
    this.timer.unref?.();
  }
  envelope(status, output = []) {
    return { id: this.id, object: "response", created_at: Math.floor(Date.now() / 1000),
      model: this.model, status, output, error: null };
  }
  item(status = "completed") {
    return { id: this.itemId, type: "message", role: "assistant", phase: "commentary", status,
      content: [{ type: "output_text", text: this.text, annotations: [] }] };
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
    this.text = WAIT_TEXT;
    active.set(this.response, this);
    this.response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
    this.response.flushHeaders();
    this.emit({ type: "response.created", response: this.envelope("in_progress") });
    this.emit({ type: "response.output_item.added", output_index: 0,
      item: { ...this.item("in_progress"), content: [] } });
    this.emit({ type: "response.content_part.added", item_id: this.itemId, output_index: 0, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] } });
    this.emit({ type: "response.output_text.delta", item_id: this.itemId, output_index: 0, content_index: 0, delta: WAIT_TEXT });
  }
  ready() { this.finish(READY_TEXT); }
  finish(suffix) {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.started || this.finished) return;
    this.finished = true;
    this.text += suffix;
    this.emit({ type: "response.output_text.delta", item_id: this.itemId, output_index: 0, content_index: 0, delta: suffix });
    this.emit({ type: "response.output_text.done", item_id: this.itemId, output_index: 0, content_index: 0, text: this.text });
    this.emit({ type: "response.content_part.done", item_id: this.itemId, output_index: 0, content_index: 0, part: this.item().content[0] });
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
