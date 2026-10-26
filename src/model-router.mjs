import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as zlib from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { normalizeResponseStream, normalizeToolCallId, openCodeBody, toolResponseStream } from "./tool-adapter.mjs";
import { ToolSearchError } from "./tool-search.mjs";
import { budgetHistoryBoundary, budgetToolBoundary, preservedHandoffPrefix, compactionHandoff, HandoffError } from "./compaction-handoff.mjs";
import { toolRecoveryPlan, recoverWithAnswer, answerOnlyStream } from "./tool-recovery.mjs";
import { HandoffStatus, failHandoffStatus, isHandoffStatusItem, readUpstreamFailure } from "./handoff-status.mjs";
import { authenticateCodex, codexRoot as defaultCodexRoot, INTERNAL_AUTH_HEADER, localRequestError, readBridgeKey, readOpenCodeApiKey, SECURITY_VERSION } from "./local-security.mjs";
import { createRequestGuard } from "./request-guard.mjs";
import { createLiveCatalog } from "./live-catalog.mjs";
import { CHAT_PROVIDERS, manualSlug, autoManualSlug, withManualModels, readManualKey, fetchManualProvider } from "./manual-providers.mjs";
import { providerHelp, allProviderHelp, providerNoticeStream } from "./provider-help.mjs";
import { CliModelSync, CLI_AUTO_MODEL, cliThreadId, cliProviderModel } from "./cli-model-sync.mjs";
import { WhatstokenFreeGate } from "./whatstoken-free.mjs";
import { AUTO_DEEPSEEK_MODEL, AUTO_DEEPSEEK_PROVIDERS, ProviderFallbackState,
  classifyProviderLimit, classifyTransientProviderLimit } from "./provider-fallback.mjs";

const NATIVE_ORIGINS = new Set(["https://chatgpt.com", "https://api.openai.com"]);
// These JSON endpoints belong to OpenAI, irrespective of the selected chat model.
const NATIVE_TOOL_PATHS = new Set(["/v1/images/generations", "/v1/images/edits", "/v1/alpha/search"]);
const IMPLEMENTATION = createHash("sha256").update(readFileSync(new URL(import.meta.url)))
  .update(readFileSync(new URL("./tool-adapter.mjs", import.meta.url)))
  .update(readFileSync(new URL("./compaction-handoff.mjs", import.meta.url)))
  .update(readFileSync(new URL("./local-security.mjs", import.meta.url)))
  .update(readFileSync(new URL("./handoff-status.mjs", import.meta.url)))
  .update(readFileSync(new URL("./tool-recovery.mjs", import.meta.url)))
  .update(readFileSync(new URL("./live-catalog.mjs", import.meta.url)))
  .update(readFileSync(new URL("./make-catalog.mjs", import.meta.url)))
  .update(readFileSync(new URL("./sync-models.mjs", import.meta.url)))
  .update(readFileSync(new URL("./catalog-safety.mjs", import.meta.url)))
  .update(readFileSync(new URL("./manual-providers.mjs", import.meta.url)))
  .update(readFileSync(new URL("./whatstoken-free.mjs", import.meta.url)))
  .update(readFileSync(new URL("./provider-fallback.mjs", import.meta.url)))
  .update(readFileSync(new URL("./cli-control.mjs", import.meta.url)))
  .update(readFileSync(new URL("./cli-model-sync.mjs", import.meta.url)))
  .update(readFileSync(new URL("./provider-help.mjs", import.meta.url)))
  .update(readFileSync(new URL("./chat-protocol.mjs", import.meta.url)))
  .update(readFileSync(new URL("./tool-search.mjs", import.meta.url)))
  .update(readFileSync(new URL("./usage.mjs", import.meta.url)))
  .update(readFileSync(new URL("./upstream-options.mjs", import.meta.url)))
  .update(readFileSync(new URL("./request-guard.mjs", import.meta.url)))
  .update(readFileSync(new URL("./models.json", import.meta.url))).digest("hex");
const NATIVE_HEADERS = ["authorization", "chatgpt-account-id", "openai-beta", "originator", "version", "session_id", "x-client-request-id", "user-agent", "x-openai-account-routing-override", "x-codex-turn-state"];

export function catalogRoutes(catalog) {
  const routes = new Map();
  for (const model of catalog.models) {
    if (!model.slug || !["openai", "opencode", ...Object.keys(CHAT_PROVIDERS)].includes(model.router_provider)) {
      throw new Error("モデルの転送先が不正です");
    }
    if (routes.has(model.slug)) throw new Error("モデル名が重複しています");
    if (model.router_transport !== undefined && !["responses", "chat"].includes(model.router_transport)) {
      throw new Error("モデルのAPI形式が不正です");
    }
    if (model.context_window !== undefined
        && (!Number.isSafeInteger(model.context_window) || model.context_window < 1024 || model.context_window > 10000000)) {
      throw new Error("モデルのコンテキスト上限が不正です");
    }
    const manual = CHAT_PROVIDERS[model.router_provider];
    if (manual && (![manualSlug(model.router_provider), autoManualSlug(model.router_provider)].includes(model.slug) || model.router_model !== manual.model || model.router_transport !== "chat")) {
      throw new Error("手動プロバイダーのモデル定義が不正です");
    }
    routes.set(model.slug, { provider: model.router_provider, model: model.router_model ?? model.slug,
      ...(model.context_window !== undefined ? { contextWindow: model.context_window } : {}),
      ...(model.router_transport ? { transport: model.router_transport } : {}),
      ...((model.router_provider === "opencode" && (model.router_model ?? model.slug) === AUTO_DEEPSEEK_MODEL)
        || (manual && model.slug === autoManualSlug(model.router_provider)) ? { autoFallback: true } : {}) });
  }
  for (const model of catalog.models) {
    if (model.router_provider === "opencode" && model.router_model && !routes.has(model.router_model)) {
      routes.set(model.router_model, { ...routes.get(model.slug), model: model.router_model });
    }
  }
  return routes;
}

export function routedBody(body, route, maxBytes) {
  const result = { ...body, model: route.model };
  if (route.provider === "opencode" && route.transport === "responses") return result;
  if (Array.isArray(body.input)) {
    result.input = body.input.filter((item) => {
      if (isHandoffStatusItem(item)) return false;
      if (item.type !== "reasoning") return true;
      const bridgeReasoning = typeof item.encrypted_content === "string" && item.encrypted_content.startsWith("cxb1:");
      return route.provider !== "openai" ? bridgeReasoning : !bridgeReasoning;
    }).map(normalizeToolCallId);
  }
  return route.provider !== "openai" ? openCodeBody(result, maxBytes) : result;
}

function fail(response, status, code, message) {
  if (response.headersSent) {
    if (failHandoffStatus(response, status, code, message)) return;
    if (!response.destroyed && !response.writableEnded
        && /^text\/event-stream\b/i.test(String(response.getHeader("content-type")))) {
      // Keep the HTTP stream alive long enough for Codex to receive the reason.
      response.end(`\n\nevent: response.failed\ndata: ${JSON.stringify({ type: "response.failed",
        response: { status: "failed", error: { code: "server_error",
          message: `${code} (HTTP ${status}): ${message}` } } })}\n\n`);
      return;
    }
    response.destroy();
    return;
  }
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store",
    ...([401, 403].includes(status) ? { connection: "close" } : {}) });
  response.end(JSON.stringify({ error: { type: code, message } }));
}

export function estimateInputTokens(value) {
  // Binary image transfer bytes are not text tokens. Only discount typed image
  // parts at wire-defined locations, never arbitrary strings or tool schemas.
  // 8192 is a conservative reservation, not a universal/model-exact tokenizer.
  let body = value;
  if (typeof value === "string") {
    try { body = JSON.parse(value); } catch { /* Plain strings remain text. */ }
  }
  let imageTokens = 0;
  const parts = content => Array.isArray(content) ? content.map(part => {
    if (part?.type !== "input_image") return part;
    const source = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    if (typeof source !== "string" || !(/^https?:\/\//.test(source)
        || /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(source))) return part;
    imageTokens += 8192;
    return { ...part, image_url: "[image token reservation]" };
  }) : content;
  if (body && typeof body === "object" && Array.isArray(body.input)) {
    body = { ...body, input: body.input.map(item => {
      if ([undefined, "message"].includes(item.type) && item.role === "user") return { ...item, content: parts(item.content) };
      if (["function_call_output", "custom_tool_call_output"].includes(item.type)) return { ...item, output: parts(item.output) };
      return item;
    }) };
  }
  const bytes = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  let ascii = 0;
  let nonAscii = 0;
  for (const byte of bytes) {
    if (byte < 0x80) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii / 2) + imageTokens;
}

function budgetHandoffPlan(body, route, maxBytes, threshold, forwardLimit = maxBytes) {
  const measure = (prefixEnd, preserveRecentUsers) => {
    const input = [...preservedHandoffPrefix(body.input, prefixEnd, preserveRecentUsers), ...body.input.slice(prefixEnd)];
    const routed = routedBody({ ...body, input }, route, maxBytes);
    return { prefixEnd, preserveRecentUsers, minimum: estimateInputTokens(routed), minimumBytes: Buffer.byteLength(JSON.stringify(routed)) };
  };
  if (!Array.isArray(body.input)) return { prefixEnd: -1 };
  const compacted = body.input.findLastIndex((item) => item.type === "compaction");
  const boundary = budgetHistoryBoundary(body.input);
  const preferred = boundary > compacted && boundary > 0 ? measure(boundary, false) : { prefixEnd: -1, minimum: Infinity };
  if (preferred.minimum <= threshold && preferred.minimumBytes <= forwardLimit) return preferred;
  const toolBoundary = budgetToolBoundary(body.input);
  if (toolBoundary > compacted && toolBoundary > 0) {
    const fallback = measure(toolBoundary, true);
    if (fallback.minimum < preferred.minimum || (preferred.minimumBytes > forwardLimit && fallback.minimumBytes < preferred.minimumBytes)) return fallback;
  }
  return preferred;
}

function envLimit(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export const readOpenCodeKey = readOpenCodeApiKey;

export async function fetchWithAvailabilityRetry(fetcher, url, options, onRetry = () => {}, { retry429 = true } = {}) {
  const upstream = await fetcher(url, options);
  if (upstream.status === 429 && !retry429) return upstream;
  if (![429, 502, 503].includes(upstream.status) || !upstream.body) return upstream;
  const reader = upstream.clone().body.getReader();
  const cancel = () => { reader.cancel().catch(() => {}); };
  let expired = false;
  const timer = setTimeout(() => { expired = true; cancel(); }, 1000);
  options.signal?.addEventListener("abort", cancel, { once: true });
  let text = "";
  try {
    const chunks = [];
    let bytes = 0;
    for (;;) {
      options.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8192) return upstream;
      chunks.push(Buffer.from(value));
    }
    text = Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    options.signal?.throwIfAborted();
    return upstream;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    cancel();
  }
  options.signal?.throwIfAborted();
  if (expired) return upstream;
  let error;
  try { error = JSON.parse(text).error; } catch { return upstream; }
  if (error?.type !== "server_error" || error.message !== "Upstream request failed: Endpoint is unavailable.") return upstream;
  const retryAfter = upstream.headers.get("retry-after");
  let waitMs = 500;
  if (retryAfter !== null) {
    const seconds = /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN;
    const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (!Number.isFinite(requested) || requested > 2000) return upstream;
    waitMs = Math.max(waitMs, requested);
  }
  await upstream.body.cancel();
  await delay(waitMs, undefined, { signal: options.signal });
  options.signal?.throwIfAborted();
  onRetry();
  return fetcher(url, options);
}

export function createRouter({ catalog, bridgeBase = "http://127.0.0.1:8788/v1", fetcher = fetch,
  codexRoot = defaultCodexRoot(), authenticate = (request) => authenticateCodex(request, codexRoot),
  bridgeKey = () => readBridgeKey(codexRoot),
  openCodeBase = "https://opencode.ai/inference/go/openai/v1", openCodeKey = readOpenCodeKey,
  nativeBase, allowTestOrigins = false, allowDirectResponses = false, maxBytes = 32 * 1024 * 1024, timeoutMs = 300000,
  // Accept bounded history before reducing it to the smaller forwarding budget.
  maxRequestBytes = maxBytes * 4,
  whatstokenFreeEnabled = process.env.CODEX_WHATSTOKEN_FREE === "1", whatstokenFreeGate,
  manualProvidersEnabled = false, manualKey = provider => readManualKey(provider, codexRoot),
  cliModelSync, cliModelSyncEnabled = false,
  providerFallbackState, providerFallbackFile = join(codexRoot, "provider-fallback-state.json"),
  providerFallbackCooldownMs = envLimit("CODEX_PROVIDER_FALLBACK_COOLDOWN_MS", 300000),
  autoProviderFallback = manualProvidersEnabled && process.env.CODEX_AUTO_PROVIDER_FALLBACK !== "0",
  summaryModel = "gpt-6.1-sol", summaryInputLimitTokens = 200000, onMetric = () => {}, handoffStatusDelayMs = 1000, toolRecoveryOptions, catalogProvider,
  autoBudgetHandoff = process.env.OPENCODE_AUTO_BUDGET_HANDOFF !== "0",
  opencodeSoftLimitTokens = envLimit("OPENCODE_SOFT_LIMIT_TOKENS", 900000),
  opencodeHardLimitTokens = envLimit("OPENCODE_HARD_LIMIT_TOKENS", 1000000) } = {}) {
  if (![maxBytes, maxRequestBytes].every(n => Number.isSafeInteger(n) && n > 0) || maxRequestBytes < maxBytes) {
    throw new Error("受信上限は送信上限以上の正の整数で指定してください");
  }
  if (manualProvidersEnabled) catalog = withManualModels(catalog, { whatstoken: whatstokenFreeEnabled });
  let routes = catalogRoutes(catalog);
  let modelSync = cliModelSync;
  const getModelSync = () => modelSync ??= new CliModelSync({ root: codexRoot,
    routerBase: `http://127.0.0.1:${server.address()?.port ?? 8790}/v1` });
  let fallbackState = providerFallbackState;
  const getFallbackState = () => fallbackState ??= new ProviderFallbackState({
    file: providerFallbackFile, unknownCooldownMs: providerFallbackCooldownMs,
  });
  const manualGuard = createRequestGuard();
  const freeGate = whatstokenFreeGate ?? new WhatstokenFreeGate({ reserveMs: timeoutMs });
  const commitCatalog = candidate => {
    if (manualProvidersEnabled) candidate = withManualModels(candidate, { whatstoken: whatstokenFreeEnabled });
    const nextRoutes = catalogRoutes(candidate);
    const models = candidate.models.map(({ router_provider, router_model, router_transport, ...model }) => model);
    const serialized = JSON.stringify({ models });
    if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error("catalog_too_large");
    catalog = candidate; routes = nextRoutes;
    return serialized;
  };
  const expandCompaction = compactionHandoff({ fetcher, model: summaryModel, maxBytes, maxInputBytes: maxRequestBytes, inputLimitTokens: summaryInputLimitTokens, measureTokens: estimateInputTokens });
  const bridge = new URL(bridgeBase);
  const direct = new URL(openCodeBase);
  if ((direct.origin !== "https://opencode.ai" && !(allowTestOrigins && direct.protocol === "http:"
      && ["127.0.0.1", "[::1]"].includes(direct.hostname))) || direct.username || direct.password || direct.search || direct.hash) {
    throw new Error("OpenCode認証の転送先は公式originに限定されます");
  }
  if (bridge.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(bridge.hostname)
      || bridge.username || bridge.password || bridge.search || bridge.hash) {
    throw new Error("OpenCodeブリッジはloopback HTTPで指定してください");
  }
  if (nativeBase) {
    const destination = new URL(nativeBase);
    if ((!allowTestOrigins && !NATIVE_ORIGINS.has(destination.origin)) || destination.username || destination.password) {
      throw new Error("OpenAI認証の転送先は公式originに限定されます");
    }
  }
  const server = http.createServer(async (request, response) => {
    if (localRequestError(request)) {
      fail(response, 403, "local_request_required", "本人用loopback CLI接続だけを受け付けます");
      return;
    }
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (request.method === "GET" && path === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, mode: "unified", implementation: IMPLEMENTATION, security: SECURITY_VERSION, models: catalog.models.length,
        live_catalog: Boolean(catalogProvider),
        whatstoken_free: { enabled: whatstokenFreeEnabled, configured: Boolean(manualKey('whatstoken')) },
        request_limits: { received_bytes: maxRequestBytes, decoded_bytes: maxRequestBytes, forwarded_bytes: maxBytes },
        history_transport: allowDirectResponses ? "model" : "chat",
        direct_header: "x-codex-bridge-direct",
        direct_models: (allowDirectResponses ? catalog.models : []).filter((model) => model.router_provider === "opencode" && model.router_transport === "responses").map((model) => model.slug),
        model_ids: catalog.models.map((model) => model.slug) }));
      return;
    }
    if (request.method === "GET" && path === "/codex/models" && catalogProvider) {
      if (!/^Bearer \S+$/i.test(request.headers.authorization ?? "") || !authenticate(request)) {
        fail(response, 401, "authentication_required", "Codexのログイン認証が必要です"); return;
      }
      const version = new URL(request.url, "http://127.0.0.1").searchParams.get("client_version");
      if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
        fail(response, 400, "client_version_required", "Codexのclient_versionが必要です"); return;
      }
      try {
        const candidate = await catalogProvider.get(request.headers, version);
        const serialized = commitCatalog(candidate);
        const etag = '"' + createHash("sha256").update(serialized).digest("hex") + '"';
        const headers = { "content-type": "application/json", "cache-control": "private, max-age=300", etag };
        if (request.headers["if-none-match"] === etag) { response.writeHead(304, headers); response.end(); }
        else { response.writeHead(200, headers); response.end(serialized); }
      } catch { fail(response, 503, "catalog_unavailable", "モデル一覧を更新できません。直前の一覧を保持しています"); }
      return;
    }
    if (request.method === "GET" && path === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: catalog.models.map((model) => ({
        id: model.slug, object: "model", owned_by: model.router_provider,
      })) }));
      return;
    }
    const nativeTool = NATIVE_TOOL_PATHS.has(request.url);
    if (request.method !== "POST" || (!nativeTool && !["/v1/responses", "/v1/responses/compact"].includes(path))) {
      fail(response, 404, "not_found", "未対応のパスです");
      return;
    }
    if (!/^Bearer \S+$/i.test(request.headers.authorization ?? "") || !authenticate(request)) {
      fail(response, 401, "authentication_required", "Codexのログイン認証を有効にして接続し直してください");
      return;
    }
    const abort = new AbortController();
    let terminationReason;
    const stop = reason => { terminationReason ??= reason; abort.abort(); };
    let readingBody = true;
    abort.signal.addEventListener("abort", () => {
      if (readingBody && terminationReason === "deadline_exceeded" && !response.destroyed) {
        response.once("finish", () => request.destroy());
        fail(response, 504, "request_timeout", "入力の受信がタイムアウトしました");
      }
    }, { once: true });
    const timer = setTimeout(() => stop("deadline_exceeded"), timeoutMs);
    response.on("close", () => { if (!response.writableEnded) stop("client_disconnected"); });
    response.on("error", () => stop("client_disconnected"));
    request.on("aborted", () => stop("client_request_aborted"));
    let handoffStatus;
    const started = performance.now();
    const metric = { event: "router_request", request_id: randomUUID(), path,
      summary_cache: "unused", summary_ms: 0, stage: "input", received_bytes: 0, response_bytes: 0 };
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        metric.received_bytes = size;
        if (size > maxRequestBytes) {
          metric.input_limit_reason = "wire_bytes";
          fail(response, 413, "request_too_large", "入力が大きすぎます");
          return;
        }
        chunks.push(chunk);
      }
      readingBody = false;
      metric.received_bytes = size;
      if (abort.signal.aborted) return;
      let body;
      let payload = Buffer.concat(chunks);
      const encoding = request.headers["content-encoding"] ?? "identity";
      const decompress = new Map([["gzip", zlib.gunzipSync], ["deflate", zlib.inflateSync],
        ["br", zlib.brotliDecompressSync], ["zstd", zlib.zstdDecompressSync]]).get(encoding);
      if (encoding !== "identity" && !decompress) {
        fail(response, 415, "unsupported_encoding", "このNode.jsでは圧縮形式を扱えません。新しいNode.jsを使用してください");
        return;
      }
      try {
        if (decompress) payload = decompress(payload, { maxOutputLength: maxRequestBytes });
        metric.decoded_bytes = payload.length;
        body = JSON.parse(payload.toString("utf8"));
      } catch (error) {
        const oversized = error.code === "ERR_BUFFER_TOO_LARGE";
        if (oversized) metric.input_limit_reason = "decoded_bytes";
        fail(response, oversized ? 413 : 400, oversized ? "request_too_large" : "invalid_json", oversized ? "入力が大きすぎます" : "JSONが不正です");
        return;
      }
      if (!body || Array.isArray(body) || typeof body !== "object") {
        fail(response, 400, "invalid_request", "リクエストはJSON objectで指定してください");
        return;
      }
      if (!nativeTool && ((body.tools != null && (!Array.isArray(body.tools) || body.tools.some((tool) => !tool || typeof tool.type !== "string")))
          || (Array.isArray(body.input) && body.input.some((item) => !item || typeof item !== "object")))) {
        fail(response, 400, "invalid_request", "toolsまたはinputの形式が不正です");
        return;
      }
      let route = nativeTool ? { provider: "openai" } : routes.get(body.model);
      // A session may retain its automatic ID after the feature is disabled.
      if (!route && !whatstokenFreeEnabled && body.model === autoManualSlug('whatstoken'))
        route = routes.get(CLI_AUTO_MODEL);
      if (!route && catalogProvider && typeof body.model === "string"
          && /^(?:opencode\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.model)) {
        const version = typeof request.headers.version === "string" ? request.headers.version.split("-")[0] : undefined;
        if (/^\d+\.\d+\.\d+$/.test(version ?? "")) {
          try {
            commitCatalog(await catalogProvider.get(request.headers, version));
            route = routes.get(body.model);
          } catch { /* Preserve the last working registry and reject unknown routes. */ }
        }
      }
      if (!route) {
        fail(response, 400, "unknown_model", "統合カタログにないモデルです。カタログを再生成してください");
        return;
      }
      if (route.provider === "opencode" && route.transport === "responses"
          && (!allowDirectResponses || request.headers["x-codex-bridge-direct"] !== "1")) {
        route = { ...route, transport: "chat" };
      }
      const requestedProvider = route.provider;
      const providerNotices = [];
      let cliContext;
      if (cliModelSyncEnabled && autoProviderFallback && route.transport !== "responses" && path === "/v1/responses"
          && !body.input?.some?.(item => item.type === "compaction_trigger")) {
        cliContext = await getModelSync().prepare(cliThreadId(body, request.headers),
          route.provider === "opencode" && route.autoFallback ? CLI_AUTO_MODEL : body.model,
          reason => { metric.cli_model_sync_reason = reason; });
        if (route.autoFallback) metric.cli_model_sync = cliContext ? "ready"
          : metric.cli_model_sync_reason === "manual_selection" ? "manual" : "unavailable";
      }
      let fallbackRoutes = [];
      if (autoProviderFallback && route.autoFallback && route.transport !== "responses"
          && path === "/v1/responses" && !body.input?.some?.(item => item.type === "compaction_trigger")) {
        const state = getFallbackState();
        const goRoute = routes.get(CLI_AUTO_MODEL) ?? (route.provider === "opencode" ? route : null);
        const providerRoutes = new Map(goRoute ? [["opencode", { ...goRoute, transport: "chat" }]] : []);
        for (const provider of AUTO_DEEPSEEK_PROVIDERS.slice(1)) {
          const candidate = routes.get(autoManualSlug(provider)) ?? routes.get(manualSlug(provider));
          if (candidate && CHAT_PROVIDERS[candidate.provider]) providerRoutes.set(provider, candidate);
        }
        let order = AUTO_DEEPSEEK_PROVIDERS;
        if (whatstokenFreeEnabled && manualKey('whatstoken')) {
          const eligibility = await freeGate.check(abort.signal);
          metric.whatstoken_free = eligibility.allowed ? 'eligible' : eligibility.reason;
          const candidate = routes.get(autoManualSlug('whatstoken'));
          if (eligibility.allowed && candidate) {
            providerRoutes.set('whatstoken', candidate);
            order = ['whatstoken', ...order];
          }
        }
        const available = state.candidates(order).filter(provider => providerRoutes.has(provider));
        const ready = available.filter(provider => provider === "opencode"
          ? Boolean(bridgeKey())
          : Boolean(manualKey(provider)));
        if (!ready.length) {
          if (!available.length) {
            const earliest = state.earliestUnblockAt(order);
            if (earliest) response.setHeader("retry-after", String(Math.max(1, Math.ceil((earliest - state.now()) / 1000))));
            fail(response, 429, "provider_limits_exhausted",
              "DeepSeek V4.1 Flashの全提供元が一時制限または利用枠制限中です。制限解除を待つか、利用枠・支払い設定を確認してください。" + allProviderHelp());
          } else {
            fail(response, 503, "auto_provider_credentials_required",
              "自動切替候補の認証情報を準備してください。選択モデルと会話履歴は保持しています。" + allProviderHelp());
          }
          return;
        }
        route = providerRoutes.get(ready[0]);
        fallbackRoutes = ready.slice(1).map(provider => providerRoutes.get(provider));
        metric.requested_provider = requestedProvider;
        metric.auto_fallback = true;
        metric.auto_available_providers = ready;
      }
      metric.provider = route.provider;
      const directResponses = route.provider === "opencode" && route.transport === "responses";
      if (directResponses) metric.transport = "responses";
      metric.model = nativeTool ? undefined : body.model;
      metric.input_items = Array.isArray(body.input) ? body.input.length : undefined;
      metric.tools_count = Array.isArray(body.tools) ? body.tools.length : 0;
      metric.tools_bytes = Array.isArray(body.tools) ? Buffer.byteLength(JSON.stringify(body.tools)) : 0;
      metric.instructions_bytes = typeof body.instructions === "string" ? Buffer.byteLength(body.instructions) : 0;
      metric.input_bytes = Array.isArray(body.input) ? Buffer.byteLength(JSON.stringify(body.input)) : 0;
      // Codex remote compaction v2 sends a normal Responses request ending in
      // compaction_trigger and requires one compaction output item. The Chat
      // conversion cannot produce that wire item, so use the native summary
      // model for this request while the surrounding turn keeps its selection.
      const remoteCompaction = route.provider !== "openai" && !directResponses && path === "/v1/responses"
        && Array.isArray(body.input) && body.input.some(item => item.type === "compaction_trigger");
      if (remoteCompaction) {
        const summaryRoute = routes.get(summaryModel);
        if (summaryRoute?.provider !== "openai") {
          fail(response, 422, "remote_compaction_model_required", "remote compactionに使えるOpenAIモデルがカタログにありません");
          return;
        }
        metric.requested_provider = route.provider;
        metric.remote_compaction_fallback = "openai";
        route = summaryRoute;
        // The model override belongs only to this compaction request. It never
        // changes the catalog, thread selection, or the next normal turn.
        body = { ...body, model: summaryModel, tools: [], tool_choice: "none" };
      }
      if (route.provider !== "openai" && !directResponses && path.endsWith("/compact")) {
        fail(response, 422, "unsupported_compaction", "OpenCode経由のremote compactionには未対応です");
        return;
      }
      if (!nativeTool && !directResponses && body.previous_response_id) {
        fail(response, 422, "history_required", "提供元をまたぐため、previous_response_idではなく全履歴を送信してください");
        return;
      }
      if (route.provider !== "openai" && !directResponses && Array.isArray(body.input)
          && body.input.some((item) => item.type === "item_reference")) {
        fail(response, 422, "history_required", "参照IDだけでは履歴を引き継げません。展開した履歴が必要です");
        return;
      }
      const requestedOutputLimit = body.max_output_tokens;
      const recovery = route.provider !== "openai" && !nativeTool ? toolRecoveryPlan(body.input, toolRecoveryOptions) : null;
      if (recovery) {
        metric.tool_recovery = recovery.reason;
        metric.tool_recovery_rounds = recovery.rounds;
        body = recoverWithAnswer(body);
      }
      let headers = { "content-type": "application/json", accept: nativeTool ? "application/json" : "text/event-stream, application/json" };
      if (route.provider === "opencode" && !directResponses) {
        const key = bridgeKey();
        if (!key) {
          fail(response, 503, "local_bridge_key_required", "ローカル中継鍵を安全な権限で準備してください");
          return;
        }
        headers[INTERNAL_AUTH_HEADER] = key;
      }
      const nativeDestination = nativeBase ?? (/^Bearer sk-/i.test(request.headers.authorization)
        ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api/codex");
      let destination = bridge.href.replace(/\/$/, "");
      if (directResponses) {
        const key = openCodeKey();
        if (!key) {
          fail(response, 503, "opencode_auth_required", "OpenCode GoのAPIキーを設定してください。GPTへの自動切替は行いません");
          return;
        }
        destination = direct.href.replace(/\/$/, "");
        headers.authorization = "Bearer " + key;
        headers["user-agent"] = request.headers["user-agent"] ?? "codex-bridge/official-responses";
        const session = request.headers.session_id ?? body.client_metadata?.thread_id ?? body.prompt_cache_key ?? body.client_metadata?.session_id;
        if (typeof session === "string" && session.length > 0 && session.length <= 200) {
          headers["x-opencode-session"] = session;
          headers.session_id = session;
        }
      }
      let manual = CHAT_PROVIDERS[route.provider];
      if (manual) {
        const key = manualKey(route.provider);
        if (!key) {
          fail(response, 503, "provider_key_required", `${manual.label}のAPIキーを安全な設定に登録してください。選択モデルは保持しています${providerHelp(route.provider)}`);
          return;
        }
        const guarded = manualGuard.check(body.client_metadata?.thread_id ?? body.prompt_cache_key ?? body.client_metadata?.session_id);
        if (!guarded.allowed) {
          response.setHeader("retry-after", String(guarded.retryAfterSeconds));
          fail(response, 429, "rate_limit_exceeded", "この会話の手動プロバイダー要求が1分間に40回を超えました。しばらく待って再試行してください");
          return;
        }
        destination = manual.base;
        headers.authorization = "Bearer " + key;
      }
      if (route.provider === "openai") {
        destination = nativeDestination;
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === "string" && name !== "x-codex-bridge-direct" && name !== INTERNAL_AUTH_HEADER
              && (NATIVE_HEADERS.includes(name) || name.startsWith("x-codex-") || name.startsWith("x-openai-"))) {
            headers[name] = value;
          }
        }
      }
      const summaryHeaders = { "content-type": "application/json", accept: "text/event-stream, application/json" };
      for (const name of ["authorization", "chatgpt-account-id", "openai-beta", "originator", "version", "user-agent"]) {
        if (typeof request.headers[name] === "string") summaryHeaders[name] = request.headers[name];
      }
      handoffStatus = new HandoffStatus(response, { model: body.model,
        enabled: body.stream === true && route.provider !== "openai" && !directResponses, delayMs: handoffStatusDelayMs });
      const handoffOptions = { destination: nativeDestination, headers: summaryHeaders, signal: abort.signal,
        diagnose: details => Object.assign(metric, details),
        threadId: body.client_metadata?.thread_id ?? body.prompt_cache_key ?? body.client_metadata?.session_id };
      const summaryContext = routes.get(summaryModel)?.contextWindow;
      const summaryBudget = Math.min(summaryInputLimitTokens, summaryContext ? Math.floor(summaryContext * 0.8) : summaryInputLimitTokens);
      handoffOptions.inputBudgetTokens = summaryBudget;
      if (remoteCompaction) {
        const reserved = Math.max(16384, Number.isSafeInteger(body.max_output_tokens) ? body.max_output_tokens : 0);
        const protectedInput = body.input.filter(item => ["system", "developer"].includes(item.role) || item.type === "compaction_trigger");
        if (estimateInputTokens({ ...body, input: protectedInput }) + reserved >= summaryBudget) {
          fail(response, 413, "summary_input_budget_exceeded", "保護された指示だけで要約モデルの入力上限を超えています。履歴と選択モデルは保持しています");
          return;
        }
        if (estimateInputTokens(body) + reserved >= summaryBudget || Buffer.byteLength(JSON.stringify(body)) > maxBytes) {
          if (body.input.at(-1)?.type !== "compaction_trigger" || body.input.length < 2
              || body.input.slice(0, -1).some(item => item.type === "compaction_trigger")) {
            fail(response, 422, "invalid_compaction_trigger", "圧縮要求の履歴境界が不正です。履歴は保持しています");
            return;
          }
          const plan = budgetHandoffPlan(body, route, maxRequestBytes, summaryBudget - reserved, maxBytes);
          if (!(plan.prefixEnd > 0) || plan.minimum + reserved >= summaryBudget || plan.minimumBytes >= maxBytes) {
            fail(response, 413, "summary_input_budget_exceeded", "最新依頼・指示・未完了ツールを保持すると要約モデルの入力上限を超えます。履歴と選択モデルは保持しています");
            return;
          }
          metric.stage = "remote_compaction_handoff";
          body = await expandCompaction(body, { ...handoffOptions, ...plan });
          metric.remote_compaction_prepared = true;
        }
        if (estimateInputTokens(body) + reserved >= summaryBudget || Buffer.byteLength(JSON.stringify(body)) > maxBytes) {
          fail(response, 413, "summary_input_budget_exceeded", "要約後も圧縮要求が入力上限を超えています。履歴と選択モデルは保持しています");
          return;
        }
      }
      let hardLimitTokens = opencodeHardLimitTokens;
      let softLimitTokens = opencodeSoftLimitTokens;
      if (route.provider !== "openai" && !directResponses && route.contextWindow && hardLimitTokens > 0) {
        const reserved = Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0 ? body.max_output_tokens : 0;
        // Token counting is an estimate; keep the same 5% margin as the catalog.
        const available = Math.floor(route.contextWindow * 0.95) - reserved;
        metric.model_context_window = route.contextWindow;
        metric.reserved_output_tokens = reserved;
        if (available <= 0) {
          metric.stage = "budget_rejected";
          fail(response, 413, "output_budget_exceeded", "指定された出力予約では、このモデルの入力容量が残りません。max_output_tokensを減らしてください。");
          return;
        }
        hardLimitTokens = Math.min(hardLimitTokens, available);
        softLimitTokens = softLimitTokens > 0 ? Math.min(softLimitTokens, hardLimitTokens) : 0;
        metric.effective_input_limit_tokens = hardLimitTokens;
      }
      let compactionExpanded = false;
      if (route.provider !== "openai" && !directResponses && autoBudgetHandoff) {
        const reused = expandCompaction.reuseBudget(body, handoffOptions);
        if (reused) {
          const preview = JSON.stringify(routedBody(reused, route, maxRequestBytes));
          const threshold = softLimitTokens > 0
            ? Math.min(softLimitTokens, hardLimitTokens) : hardLimitTokens;
          if (threshold > 0 && estimateInputTokens(preview) <= threshold && Buffer.byteLength(preview) <= maxBytes) {
            body = reused;
            metric.budget_prefix_cache = "hit";
            compactionExpanded = true;
          }
        }
      }
      if (!compactionExpanded && route.provider !== "openai" && !directResponses && Array.isArray(body.input) && body.input.some((item) => item.type === "compaction")) {
        if (routes.get(summaryModel)?.provider !== "openai") {
          fail(response, 422, "summary_model_required", "圧縮履歴の引き継ぎに使うOpenAIモデルがカタログにありません");
          return;
        }
        metric.stage = "handoff";
        const summaryStart = performance.now();
        try {
          const threshold = softLimitTokens > 0
            ? Math.min(softLimitTokens, hardLimitTokens) : hardLimitTokens;
          const plan = budgetHandoffPlan(body, route, maxRequestBytes, threshold, maxBytes);
          const preview = JSON.stringify(routedBody(body, route, maxRequestBytes));
          const extend = autoBudgetHandoff && hardLimitTokens > 0
            && plan.prefixEnd > body.input.findLastIndex((item) => item.type === "compaction") + 1
            && (estimateInputTokens(preview) > threshold || Buffer.byteLength(preview) > maxBytes);
          if (extend) metric.budget_compaction_extended = true;
          if (extend && plan.preserveRecentUsers) metric.budget_intra_turn = true;
          body = await expandCompaction(body, { ...handoffOptions, ...(extend ? plan : {}),
            observe: ({ cache }) => { metric.summary_cache = cache; handoffStatus.observe(cache, extend ? "budget" : "handoff"); } });
          compactionExpanded = true;
        } finally { metric.summary_ms = Math.round(performance.now() - summaryStart); }
      }
      const suffix = nativeTool ? path.slice(3) : path.endsWith("/compact") ? "/responses/compact" : "/responses";
      let routed;
      let routedObject;
      try {
        routedObject = nativeTool ? body : routedBody(body, route, maxRequestBytes);
        routed = JSON.stringify(routedObject);
        const initialBytes = Buffer.byteLength(routed);
        const initialTokens = route.provider !== "openai" ? estimateInputTokens(routed) : 0;
        const threshold = softLimitTokens > 0
          ? Math.min(softLimitTokens, hardLimitTokens) : hardLimitTokens;
        if (route.provider !== "openai" && hardLimitTokens > 0 && softLimitTokens > hardLimitTokens) {
          metric.budget_limit_clamped = true;
        }
        if (route.provider !== "openai" && !directResponses && autoBudgetHandoff && hardLimitTokens > 0
            && (initialTokens > threshold || initialBytes > maxBytes) && !compactionExpanded) {
          metric.budget_initial_tokens = initialTokens;
          metric.budget_initial_bytes = initialBytes;
          const plan = budgetHandoffPlan(body, route, maxRequestBytes, threshold, maxBytes);
          const { prefixEnd, minimum, minimumBytes } = plan;
          if (prefixEnd > 0 && prefixEnd < body.input.length) {
            if (minimum < hardLimitTokens && minimumBytes < maxBytes && routes.get(summaryModel)?.provider === "openai" && summaryHeaders.authorization) {
              metric.stage = "budget_handoff";
              if (plan.preserveRecentUsers) metric.budget_intra_turn = true;
              const summaryStart = performance.now();
              try {
                body = await expandCompaction(body, { ...handoffOptions, ...plan,
                  observe: ({ cache }) => { metric.budget_summary_cache = cache; handoffStatus.observe(cache, "budget"); } });
              } finally { metric.budget_summary_ms = Math.round(performance.now() - summaryStart); }
              routedObject = routedBody(body, route, maxBytes);
              routed = JSON.stringify(routedObject);
              if (Buffer.byteLength(routed) > maxBytes) throw new RangeError("expanded request too large");
              metric.budget_recovered = estimateInputTokens(routed) <= hardLimitTokens;
            } else metric.budget_recovery_skipped = minimum >= hardLimitTokens || minimumBytes >= maxBytes ? "protected_input_too_large"
              : !summaryHeaders.authorization ? "summary_auth_missing" : "summary_model_missing";
          } else metric.budget_recovery_skipped = "no_completed_history";
        }
        if (Buffer.byteLength(routed) > maxBytes) throw new RangeError("expanded request too large");
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        metric.input_limit_reason = "forwarded_bytes";
        fail(response, 413, "request_too_large", "変換後の入力が大きすぎます");
        return;
      }
      handoffStatus.ready();
      metric.forwarded_bytes = Buffer.byteLength(routed);
      metric.forwarded_tools_bytes = Array.isArray(routedObject.tools)
        ? Buffer.byteLength(JSON.stringify(routedObject.tools)) : 0;
      metric.estimated_input_tokens = estimateInputTokens(routed);
      if (metric.budget_compaction_extended) metric.budget_recovered = metric.estimated_input_tokens <= hardLimitTokens;
      if (route.provider !== "openai" && !directResponses && softLimitTokens > 0
          && metric.estimated_input_tokens > softLimitTokens) {
        metric.budget_warning = true;
      }
      if (route.provider !== "openai" && !directResponses && hardLimitTokens > 0
          && metric.estimated_input_tokens > hardLimitTokens) {
        metric.stage = "budget_rejected";
        fail(response, 413, "input_budget_exceeded",
          `OpenCodeの入力が推定${metric.estimated_input_tokens}トークンで上限${hardLimitTokens}を超えます。`
          + `最新の依頼・進行中のツール・指示・ツール定義を保持したままでは上限内に収まりません。`
          + `不要なMCPを無効化するか、/compactを実行して再試行してください`
          + `（tools=${metric.tools_count}, tools_bytes=${metric.tools_bytes}）。`);
        return;
      }
      metric.stage = "upstream_headers";
      const upstreamStart = performance.now();
      const makeRouteFetch = (candidateRoute, inputLimit = hardLimitTokens) => CHAT_PROVIDERS[candidateRoute.provider]
        ? async (url, options) => {
          if (candidateRoute.provider === 'whatstoken') {
            const eligibility = whatstokenFreeEnabled ? await freeGate.check(options.signal) : { allowed: false };
            const remaining = eligibility.end - (freeGate.now?.() ?? Date.now()) - 5000;
            if (!eligibility.allowed || !Number.isSafeInteger(remaining) || remaining <= 0)
              return Response.json({ error: { code: 'free_window_unavailable' } }, { status: 503 });
            const deadline = AbortSignal.timeout(Math.min(remaining, timeoutMs));
            options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline };
          }
          try { return await fetchManualProvider(candidateRoute.provider, url, options, fetcher, maxBytes,
          chat => inputLimit <= 0 || estimateInputTokens({ ...chat, messages: undefined, input: chat.messages.map(message => ({ ...message, role: "user",
            content: Array.isArray(message.content) ? message.content.map(part => part.type === "image_url"
              ? { type: "input_image", image_url: part.image_url } : part) : message.content })) }) <= inputLimit,
          candidateRoute.provider === 'whatstoken' ? [
            ...Object.keys(CHAT_PROVIDERS).map(manualKey), bridgeKey(), openCodeKey(),
            request.headers.authorization?.replace(/^Bearer /i, ''),
          ] : []); }
          catch (error) {
            if (error instanceof ToolSearchError || candidateRoute.provider !== 'whatstoken' || options.signal?.aborted) throw error;
            return Response.json({ error: { code: 'whatstoken_unavailable' } }, { status: 503 });
          }
        }
        : fetcher;
      // Bind the provider that owns the transformed request. Recovery retries
      // must continue to use that same provider and conversion path.
      let routeFetch = makeRouteFetch(route);
      let send = route.provider === "opencode"
        ? (url, options) => fetchWithAvailabilityRetry(fetcher, url, options, () => { metric.upstream_retries = 1; },
          { retry429: !metric.auto_fallback }) : routeFetch;
      const syncSelection = async () => {
        if (cliContext) {
          metric.cli_model_sync = await getModelSync().sync(cliContext,
            cliProviderModel(route.provider));
        }
      };
      await syncSelection();
      let upstream = await send(destination.replace(/\/$/, "") + suffix, {
        method: "POST", headers, body: routed,
        signal: abort.signal, redirect: "manual",
      });
      if (metric.auto_fallback) {
        const state = getFallbackState();
        const conversationId = body.client_metadata?.thread_id ?? body.prompt_cache_key ?? body.client_metadata?.session_id;
        const skipped = [];
        for (;;) {
          if (upstream.ok || (route.provider !== 'whatstoken' && ![402, 429].includes(upstream.status))) break;
          const limit = await classifyProviderLimit(upstream, {
            now: state.now(), unknownCooldownMs: providerFallbackCooldownMs,
          });
          const transient = !limit && route.provider !== 'whatstoken'
            ? await classifyTransientProviderLimit(upstream, { now: state.now() }) : null;
          if (limit) {
            try { state.recordLimit(route.provider, limit); }
            catch { metric.provider_state_error = true; } // The in-memory block remains active.
          }
          if (transient) {
            state.recordTransient(route.provider, transient);
            metric.provider_transient_provider = route.provider;
          }
          if (!limit && !transient && route.provider !== 'whatstoken') break;
          if (route.provider === 'whatstoken') freeGate.unavailable?.();
          providerNotices.push(transient ? `${route.provider}が一時制限中のため、別の提供元へ切り替えます。` : route.provider === 'whatstoken'
            ? 'WhatsTokenの無料経路が利用できないため、既存の提供元へ切り替えます。' + providerHelp('whatstoken')
            : `提供元の利用枠を確認してください。${providerHelp(route.provider)}`);
          if (limit) {
            metric.provider_limit_provider = route.provider;
            metric.provider_limit_window = limit.window;
            metric.provider_limit_reset_known = limit.resetKnown;
          }
          let next = null;
          while (fallbackRoutes.length) {
            const candidateRoute = fallbackRoutes.shift();
            if (!state.available(candidateRoute.provider)) {
              skipped.push(candidateRoute.provider);
              continue;
            }
            const candidateManual = CHAT_PROVIDERS[candidateRoute.provider];
            const isGo = candidateRoute.provider === 'opencode';
            const key = isGo ? bridgeKey() : candidateManual ? manualKey(candidateRoute.provider) : null;
            if ((!candidateManual && !isGo) || !key) {
              skipped.push(candidateRoute.provider);
              continue;
            }
            const guarded = manualGuard.check(conversationId);
            if (!guarded.allowed) {
              skipped.push(candidateRoute.provider);
              continue;
            }
            const nextObject = { ...routedObject, model: candidateRoute.model };
            const nextSerialized = JSON.stringify(nextObject);
            const reserved = Number.isSafeInteger(nextObject.max_output_tokens) && nextObject.max_output_tokens > 0
              ? nextObject.max_output_tokens : 0;
            const candidateLimit = opencodeHardLimitTokens > 0 && candidateRoute.contextWindow
              ? Math.min(opencodeHardLimitTokens, Math.floor(candidateRoute.contextWindow * 0.95) - reserved)
              : opencodeHardLimitTokens;
            if (opencodeHardLimitTokens > 0) {
              if (candidateLimit <= 0 || estimateInputTokens(nextSerialized) > candidateLimit) {
                upstream.body?.cancel().catch(() => {});
                fail(response, 413, "input_budget_exceeded", "切替先の入力容量を超えます。履歴と選択モデルは保持しています");
                return;
              }
              metric.effective_input_limit_tokens = candidateLimit;
            }
            const nextHeaders = {
              "content-type": "application/json", accept: "text/event-stream, application/json",
              ...(isGo ? { [INTERNAL_AUTH_HEADER]: key } : { authorization: "Bearer " + key }),
            };
            if (isGo) {
              const session = request.headers.session_id ?? body.client_metadata?.thread_id ?? body.prompt_cache_key;
              if (typeof session === 'string' && session.length <= 200) {
                nextHeaders['x-opencode-session'] = session; nextHeaders.session_id = session;
              }
            }
            next = { route: candidateRoute, destination: isGo ? bridge.href.replace(/\/$/, '') : candidateManual.base, headers: nextHeaders,
              routedObject: nextObject, routed: nextSerialized, inputLimit: candidateLimit };
            break;
          }
          if (!next) {
            if (skipped.length) metric.fallback_skipped = skipped;
            break;
          }
          await upstream.body?.cancel().catch(() => {});
          route = next.route;
          manual = CHAT_PROVIDERS[route.provider];
          destination = next.destination;
          headers = next.headers;
          routedObject = next.routedObject;
          routed = next.routed;
          routeFetch = makeRouteFetch(route, next.inputLimit);
          send = routeFetch;
          metric.forwarded_bytes = Buffer.byteLength(routed);
          metric.provider = route.provider;
          metric.transport = undefined;
          metric.fallback_providers = [...(metric.fallback_providers ?? []), route.provider];
          metric.fallback_attempts = (metric.fallback_attempts ?? 0) + 1;
          metric.stage = "upstream_headers";
          await syncSelection();
          upstream = await routeFetch(destination.replace(/\/$/, "") + "/responses", {
            method: "POST", headers, body: routed,
            signal: abort.signal, redirect: "manual",
          });
          metric.upstream_status = upstream.status;
        }
        if (skipped.length && !metric.fallback_skipped) metric.fallback_skipped = skipped;
      }
      metric.upstream_headers_ms = Math.round(performance.now() - upstreamStart);
      metric.upstream_status = upstream.status;
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        fail(response, 502, "upstream_redirect", "転送先のリダイレクトを拒否しました");
        return;
      }
      if (metric.auto_fallback && upstream.ok) {
        const state = getFallbackState();
        try { state.recordSuccess(route.provider); } catch { metric.provider_state_error = true; }
      }
      if (!upstream.ok && route.provider === "opencode" && [401, 402, 403, 429].includes(upstream.status)) {
        const limit = await classifyProviderLimit(upstream);
        if (limit || [401, 402, 403].includes(upstream.status)) {
          const detail = upstream.body ? await readUpstreamFailure(upstream) : { code: "unknown_error" };
          upstream = Response.json({ error: { type: "provider_error", code: detail.code,
            message: `${route.provider}が要求を拒否しました（HTTP ${upstream.status}）。利用枠と認証設定を確認してください。${providerHelp(route.provider)}` } },
          { status: upstream.status, headers: upstream.headers.has("retry-after") ? { "retry-after": upstream.headers.get("retry-after") } : {} });
        }
      }
      if (!upstream.body) {
        fail(response, 502, "empty_upstream", "転送先から応答がありません");
        return;
      }
      if (handoffStatus.started && !upstream.ok) {
        const detail = await readUpstreamFailure(upstream);
        Object.assign(metric, { upstream_error_code: detail.code, upstream_error_type: detail.type, upstream_error_read: detail.read });
        fail(response, upstream.status, "upstream_error", `履歴の準備後、選択したサービスが要求を拒否しました（理由: ${detail.code}、種別: ${detail.type}、詳細取得: ${detail.read}）${providerHelp(route.provider)}`);
        return;
      }
      const responseHeaders = { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" };
      if (metric.auto_fallback) responseHeaders["x-codex-bridge-provider"] = route.provider;
      for (const name of ["retry-after", "x-request-id", "x-codex-imagegen-request-id"]) {
        if (upstream.headers.has(name)) responseHeaders[name] = upstream.headers.get(name);
      }
      if (!handoffStatus.started) {
        for (const [name, value] of Object.entries(responseHeaders)) response.setHeader(name, value);
        response.writeHead(upstream.status);
      }
      metric.stage = "upstream_stream";
      const streamStart = performance.now();
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        if (metric.first_upstream_byte_ms === undefined) {
          metric.first_upstream_byte_ms = Math.round(performance.now() - upstreamStart);
        }
        metric.response_bytes += chunk.length;
        callback(null, chunk);
      } });
      const customNames = new Set((nativeTool ? [] : body.tools ?? []).filter((tool) => tool.type === "custom").map((tool) => tool.name));
      const streams = [Readable.fromWeb(upstream.body), meter];
      if (recovery && upstream.ok) {
        const retryLimit = Math.min(requestedOutputLimit ?? 16384, 16384);
        const initialLimit = body.max_output_tokens;
        metric.recovery_output_limit = initialLimit;
        streams.push(answerOnlyStream(responseHeaders["content-type"], maxBytes, {
          diagnose: details => Object.assign(metric, details),
          retry: async reason => {
            if (reason === "length" && retryLimit <= initialLimit) return null;
            abort.signal.throwIfAborted();
            if (reason === "length") metric.recovery_length_retries = 1;
            else metric.recovery_empty_retries = 1;
            metric.recovery_retry_reason = reason;
            const nextLimit = reason === "length" ? retryLimit : initialLimit;
            metric.recovery_retry_output_limit = nextLimit;
            const retried = await routeFetch(destination.replace(/\/$/, "") + suffix, {
              method: "POST", headers, body: JSON.stringify({ ...routedObject, max_output_tokens: nextLimit }),
              signal: abort.signal, redirect: "manual",
            });
            metric.recovery_retry_upstream_status = retried.status;
            return retried;
          },
        }));
      }
      if (route.provider !== "openai" && !directResponses && upstream.ok) {
        streams.push(toolResponseStream(customNames, responseHeaders["content-type"], maxBytes));
      } else if (route.provider === "opencode" && directResponses && upstream.ok) {
        streams.push(normalizeResponseStream(responseHeaders["content-type"], maxBytes));
      }
      if (upstream.ok && providerNotices.length) streams.push(providerNoticeStream(responseHeaders["content-type"], maxBytes, providerNotices));
      if (handoffStatus.started) streams.push(handoffStatus.stream(responseHeaders["content-type"], maxBytes));
      // pipeline destroys its destination on upstream/transform failure. A
      // separate sink preserves the HTTP response so catch can send a terminal
      // SSE error, while write callbacks retain backpressure and cancellation.
      const sink = new Writable({
        write(chunk, encoding, callback) { response.write(chunk, encoding, callback); },
        final(callback) { response.end(callback); },
      });
      await pipeline(...streams, sink, { signal: abort.signal });
      metric.upstream_stream_ms = Math.round(performance.now() - streamStart);
      metric.stage = "complete";
    } catch (error) {
      terminationReason ??= metric.stage === "upstream_stream" ? "upstream_stream_error" : "upstream_error";
      const safeCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_SOCKET",
        "ERR_STREAM_PREMATURE_CLOSE", "ERR_STREAM_DESTROYED", "ABORT_ERR"]);
      const errorCode = [error?.code, error?.cause?.code].find(code => safeCodes.has(code));
      if (errorCode && !terminationReason.startsWith("client_")) metric.transport_error_code = errorCode;
      const timeout = terminationReason === "deadline_exceeded";
      if (!response.destroyed && !terminationReason.startsWith("client_")) fail(response, error instanceof ToolSearchError ? 422 : timeout ? 504 : 502,
        error instanceof ToolSearchError ? "unsupported_tool_search" : error instanceof HandoffError ? "compaction_handoff_failed" : timeout ? "request_timeout" : terminationReason,
        error instanceof ToolSearchError ? error.message : error instanceof HandoffError ? error.message : timeout ? "応答の待機がタイムアウトしました" : "転送先への接続が中断されました");
    } finally {
      handoffStatus?.dispose();
      clearTimeout(timer);
      metric.total_ms = Math.round(performance.now() - started);
      metric.status = response.statusCode;
      if (terminationReason) metric.termination_reason = terminationReason;
      metric.outcome = terminationReason?.startsWith("client_") ? "aborted"
        : terminationReason === "deadline_exceeded" ? "timeout"
        : terminationReason ? "failed" : metric.stage === "complete" ? "complete" : "rejected";
      try { onMetric(metric); } catch {}
    }
  });
  server.once("close", () => modelSync?.close?.());
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const catalog = JSON.parse(readFileSync(join(root, "unified-model-catalog.json"), "utf8"));
  const catalogProvider = createLiveCatalog({ initial: catalog,
    seed: JSON.parse(readFileSync(new URL("./models.json", import.meta.url), "utf8")).models,
    key: readOpenCodeKey, onStatus: status => console.log(JSON.stringify({ event: "catalog_refresh", status })) });
  const server = createRouter({ catalog, bridgeBase: process.env.BRIDGE_BASE ?? "http://127.0.0.1:8788/v1",
    catalogProvider, manualProvidersEnabled: process.env.CODEX_MANUAL_PROVIDERS !== "0",
    cliModelSyncEnabled: process.env.CODEX_CLI_MODEL_SYNC !== "0",
    onMetric: (metric) => console.log(JSON.stringify(metric)) });
  server.listen(Number(process.env.ROUTER_PORT ?? 8790), "127.0.0.1", () => {
    console.log("Unified model router listening on loopback");
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}
