import { createHash } from "node:crypto";

export function reasoningOptions(model, effort) {
  if (!/^deepseek-v4(?:[.-]|$)/i.test(model) || effort == null) return {};
  if (effort === "none") return { thinking: { type: "disabled" } };
  const mapped = { minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high", max: "max", ultra: "max" }[effort];
  return mapped ? { thinking: { type: "enabled" }, reasoning_effort: mapped } : {};
}

export function upstreamSession(body, fallback) {
  const thread = body.client_metadata?.thread_id ?? body.prompt_cache_key
    ?? body.client_metadata?.session_id;
  if (typeof thread !== "string" || thread.length === 0 || thread.length > 200) return fallback;
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const bytes = createHash("sha1").update(namespace).update(thread).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
