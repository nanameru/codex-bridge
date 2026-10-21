import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as zlib from "node:zlib";
import { createHash } from "node:crypto";
import { openCodeBody, toolResponseStream } from "./tool-adapter.mjs";

const NATIVE_ORIGINS = new Set(["https://chatgpt.com", "https://api.openai.com"]);
// These JSON endpoints belong to OpenAI, irrespective of the selected chat model.
const NATIVE_TOOL_PATHS = new Set(["/v1/images/generations", "/v1/images/edits", "/v1/alpha/search"]);
const IMPLEMENTATION = createHash("sha256").update(readFileSync(new URL(import.meta.url)))
  .update(readFileSync(new URL("./tool-adapter.mjs", import.meta.url))).digest("hex");
const NATIVE_HEADERS = ["authorization", "chatgpt-account-id", "openai-beta", "originator", "version", "session_id", "x-client-request-id", "user-agent", "x-openai-account-routing-override", "x-codex-turn-state"];

export function catalogRoutes(catalog) {
  const routes = new Map();
  for (const model of catalog.models) {
    if (!model.slug || !["openai", "opencode"].includes(model.router_provider)) {
      throw new Error("モデルの転送先が不正です");
    }
    if (routes.has(model.slug)) throw new Error("モデル名が重複しています");
    routes.set(model.slug, { provider: model.router_provider, model: model.router_model ?? model.slug });
  }
  for (const model of catalog.models) {
    if (model.router_provider === "opencode" && model.router_model && !routes.has(model.router_model)) {
      routes.set(model.router_model, { provider: "opencode", model: model.router_model });
    }
  }
  return routes;
}

export function routedBody(body, route, maxBytes) {
  const result = { ...body, model: route.model };
  if (Array.isArray(body.input)) {
    result.input = body.input.filter((item) => {
      if (item.type !== "reasoning") return true;
      const bridgeReasoning = typeof item.encrypted_content === "string" && item.encrypted_content.startsWith("cxb1:");
      return route.provider === "opencode" ? bridgeReasoning : !bridgeReasoning;
    });
  }
  return route.provider === "opencode" ? openCodeBody(result, maxBytes) : result;
}

function fail(response, status, code, message) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { type: code, message } }));
}

export function createRouter({ catalog, bridgeBase = "http://127.0.0.1:8788/v1", fetcher = fetch,
  nativeBase, allowTestOrigins = false, maxBytes = 32 * 1024 * 1024, timeoutMs = 300000 } = {}) {
  const routes = catalogRoutes(catalog);
  const bridge = new URL(bridgeBase);
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
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (request.method === "GET" && path === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, mode: "unified", implementation: IMPLEMENTATION, models: catalog.models.length,
        model_ids: catalog.models.map((model) => model.slug) }));
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
    if (!/^Bearer \S+$/i.test(request.headers.authorization ?? "")) {
      fail(response, 401, "authentication_required", "Codexのログイン認証を有効にして接続し直してください");
      return;
    }
    const abort = new AbortController();
    let readingBody = true;
    abort.signal.addEventListener("abort", () => {
      if (readingBody && !response.destroyed) {
        response.once("finish", () => request.destroy());
        fail(response, 504, "request_timeout", "入力の受信がタイムアウトしました");
      }
    }, { once: true });
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    response.on("close", () => { if (!response.writableEnded) abort.abort(); });
    request.on("aborted", () => abort.abort());
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBytes) {
          fail(response, 413, "request_too_large", "入力が大きすぎます");
          return;
        }
        chunks.push(chunk);
      }
      readingBody = false;
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
        if (decompress) payload = decompress(payload, { maxOutputLength: maxBytes });
        body = JSON.parse(payload.toString("utf8"));
      } catch (error) {
        const oversized = error.code === "ERR_BUFFER_TOO_LARGE";
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
      const route = nativeTool ? { provider: "openai" } : routes.get(body.model);
      if (!route) {
        fail(response, 400, "unknown_model", "統合カタログにないモデルです。カタログを再生成してください");
        return;
      }
      if (route.provider === "opencode" && path.endsWith("/compact")) {
        fail(response, 422, "unsupported_compaction", "OpenCode経由のremote compactionには未対応です");
        return;
      }
      if (!nativeTool && body.previous_response_id) {
        fail(response, 422, "history_required", "提供元をまたぐため、previous_response_idではなく全履歴を送信してください");
        return;
      }
      if (route.provider === "opencode" && Array.isArray(body.input)
          && body.input.some((item) => ["compaction", "item_reference"].includes(item.type))) {
        fail(response, 422, "history_required", "OpenCodeへ切り替えるには参照や暗号化された圧縮履歴ではなく、展開した履歴が必要です");
        return;
      }
      const headers = { "content-type": "application/json", accept: "text/event-stream, application/json" };
      let destination = bridge.href.replace(/\/$/, "");
      if (route.provider === "openai") {
        destination = nativeBase ?? (/^Bearer sk-/i.test(request.headers.authorization)
          ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api/codex");
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === "string" && (NATIVE_HEADERS.includes(name) || name.startsWith("x-codex-") || name.startsWith("x-openai-"))) {
            headers[name] = value;
          }
        }
      }
      const suffix = nativeTool ? path.slice(3) : path.endsWith("/compact") ? "/responses/compact" : "/responses";
      let routed;
      try {
        routed = JSON.stringify(nativeTool ? body : routedBody(body, route, maxBytes));
        if (Buffer.byteLength(routed) > maxBytes) throw new RangeError("expanded request too large");
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        fail(response, 413, "request_too_large", "変換後の入力が大きすぎます");
        return;
      }
      const upstream = await fetcher(destination.replace(/\/$/, "") + suffix, {
        method: "POST", headers, body: routed,
        signal: abort.signal, redirect: "manual",
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        fail(response, 502, "upstream_redirect", "転送先のリダイレクトを拒否しました");
        return;
      }
      if (!upstream.body) {
        fail(response, 502, "empty_upstream", "転送先から応答がありません");
        return;
      }
      const responseHeaders = { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" };
      for (const name of ["retry-after", "x-request-id", "x-codex-imagegen-request-id"]) {
        if (upstream.headers.has(name)) responseHeaders[name] = upstream.headers.get(name);
      }
      response.writeHead(upstream.status, responseHeaders);
      const customNames = new Set((nativeTool ? [] : body.tools ?? []).filter((tool) => tool.type === "custom").map((tool) => tool.name));
      if (route.provider === "opencode" && upstream.ok) {
        await pipeline(Readable.fromWeb(upstream.body), toolResponseStream(customNames, responseHeaders["content-type"], maxBytes),
          response, { signal: abort.signal });
      } else {
        await pipeline(Readable.fromWeb(upstream.body), response, { signal: abort.signal });
      }
    } catch {
      if (!response.destroyed) fail(response, abort.signal.aborted ? 504 : 502, "upstream_error", "転送先への接続に失敗しました");
    } finally {
      clearTimeout(timer);
    }
  });
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const catalog = JSON.parse(readFileSync(join(root, "unified-model-catalog.json"), "utf8"));
  const server = createRouter({ catalog, bridgeBase: process.env.BRIDGE_BASE ?? "http://127.0.0.1:8788/v1" });
  server.listen(Number(process.env.ROUTER_PORT ?? 8790), "127.0.0.1", () => {
    console.log("Unified model router listening on loopback");
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}
