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
  return typeof thread === "string" && thread.length > 0 && thread.length <= 200
    ? "cxb-" + createHash("sha256").update(thread).digest("hex") : fallback;
}
