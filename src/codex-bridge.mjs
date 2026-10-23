#!/usr/bin/env node
/**
 * codex-bridge — Codex(Responses API) ⇄ OpenCode Go(chat/completions) の翻訳プロキシ
 *
 * Codex 0.163 は `wire_api = "chat"` を廃止したため、/chat/completions しか
 * 提供しないモデル（DeepSeek / Kimi / GLM / Qwen ...）は直接使えない。
 * このプロキシが間に入って Responses API を chat/completions に変換する。
 *
 *   Codex ──/v1/responses──▶ codex-bridge ──/chat/completions──▶ opencode.ai
 *
 * 起動:
 *   OPENCODE_API_KEY=sk-... node codex-bridge.mjs
 *   （既定ポート 8788）
 *
 * 環境変数:
 *   OPENCODE_API_KEY     またはOpenCode Goの保存済みAPI設定
 *   PORT                 既定 8788
 *   UPSTREAM_BASE        既定 https://opencode.ai/inference/go/openai/v1
 *   DEFAULT_MODEL        モデル未指定時の既定 deepseek-v4.1-flash
 *   LOG_LEVEL            debug | info | error（既定 info）
 */

import { chatToResponses, pipeChatStream, chatMessages } from "./chat-protocol.mjs";
import http from "node:http";
import { guardBridgeRequest, validateOpenCodeBase, fetchOpenCode, readOpenCodeApiKey } from "./local-security.mjs";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { reasoningOptions, upstreamSession } from "./upstream-options.mjs";
import { createRequestGuard } from "./request-guard.mjs";

const PORT = Number(process.env.PORT ?? 8788);
const UPSTREAM_BASE = validateOpenCodeBase((process.env.UPSTREAM_BASE ?? "https://opencode.ai/inference/go/openai/v1").replace(/\/+$/, ""));
const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "deepseek-v4.1-flash";
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

// OpenCode公式APIキーのみ。ログインDBやOAuth資格情報は取り出さない。
function getToken() {
  const token = readOpenCodeApiKey();
  return { token, kind: token ? "api_key" : "none" };
}

const log = (...a) => LOG_LEVEL !== "error" && console.log(new Date().toISOString(), ...a);
const dbg = (...a) => LOG_LEVEL === "debug" && console.log(new Date().toISOString(), "[debug]", ...a);

const SESSION_ID = randomUUID();

// ---- 使用量の記録 -------------------------------------------------
const PRICES = JSON.parse(readFileSync(new URL("./prices.json", import.meta.url), "utf8"));
const usageByThread = new Map(); // thread_id -> { model, inTok, outTok, cost, turns, updated }
let totalCost = 0;
const USAGE_FILE = join(homedir(), ".home-runner", "usage.json");
try {
  const saved = JSON.parse(readFileSync(USAGE_FILE, "utf8"));
  totalCost = saved.totalCost ?? 0;
  for (const [k, v] of Object.entries(saved.threads ?? {})) usageByThread.set(k, v);
} catch {}
let saveTimer = null;
function saveUsage() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      mkdirSync(dirname(USAGE_FILE), { recursive: true });
      writeFileSync(USAGE_FILE, JSON.stringify({
        totalCost,
        threads: Object.fromEntries(usageByThread),
        savedAt: Date.now(),
      }, null, 2));
    } catch {}
  }, 1000);
}

function threadIdOf(body) {
  return (
    body?.client_metadata?.thread_id ||
    body?.client_metadata?.session_id ||
    body?.prompt_cache_key ||
    "unknown"
  );
}

function recordUsage(threadId, model, inTok, outTok) {
  if (!inTok && !outTok) return;
  const p = PRICES[model] ?? { in: 0, out: 0 };
  const cost = (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
  const cur = usageByThread.get(threadId) ?? {
    model, inTok: 0, outTok: 0, cost: 0, turns: 0, updated: 0,
  };
  cur.model = model;
  cur.inTok += inTok;
  cur.outTok += outTok;
  cur.cost += cost;
  cur.turns += 1;
  cur.updated = Date.now();
  usageByThread.set(threadId, cur);
  totalCost += cost;
  saveUsage();
}

function renderUsage() {
  const rows = [...usageByThread.entries()].sort((a, b) => b[1].updated - a[1].updated);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ago = (ts) => {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}秒前`;
    if (s < 3600) return `${Math.round(s / 60)}分前`;
    return `${Math.round(s / 3600)}時間前`;
  };
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>codex-bridge usage</title><style>
body{font-family:system-ui,-apple-system,"Hiragino Sans",sans-serif;margin:0;padding:20px;background:#0b0f16;color:#e6edf3}
h1{font-size:18px;margin:0 0 4px}.sub{color:#8b949e;font-size:12px;margin-bottom:18px}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:16px;margin-bottom:14px}
.big{font-size:32px;font-weight:700;letter-spacing:-.5px}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #21262d}
th{color:#8b949e;font-weight:500}.mono{font-family:ui-monospace,monospace}
</style></head><body>
<h1>使用量</h1><div class="sub">codex-bridge 経由の合計</div>
<div class="card"><div class="big">$${totalCost.toFixed(totalCost < 1 ? 4 : 2)}</div>
<div class="sub" style="margin:6px 0 0">${rows.length} スレッド</div></div>
<div class="card"><table>
<tr><th>スレッド</th><th>モデル</th><th>入力</th><th>出力</th><th>金額</th><th>更新</th></tr>
${rows.map(([id, u]) => `<tr>
<td class="mono">${esc(id.slice(0, 8))}</td><td>${esc(u.model)}</td>
<td class="mono">${u.inTok.toLocaleString()}</td><td class="mono">${u.outTok.toLocaleString()}</td>
<td class="mono">$${u.cost.toFixed(4)}</td><td class="sub">${ago(u.updated)}</td></tr>`).join("")}
</table></div>
<div class="sub">更新 ${new Date().toLocaleString("ja-JP")}</div>
</body></html>`;
}

// ---- 暴走ガード -------------------------------------------------
// 同一スレッドから短時間に大量リクエストが来たら止める。
// 実APIで事故ると一瞬で課金が飛ぶため、既定で有効。
const MAX_REQ_PER_MIN = Number(process.env.MAX_REQ_PER_MIN ?? 40);
// 0 は無効。多数スレッドの同時利用に備える場合だけ設定する。
const MAX_REQ_PER_MIN_GLOBAL = Number(process.env.MAX_REQ_PER_MIN_GLOBAL ?? 0);
const requestGuard = createRequestGuard({
  maxPerThread: MAX_REQ_PER_MIN,
  maxGlobal: Number.isFinite(MAX_REQ_PER_MIN_GLOBAL) ? MAX_REQ_PER_MIN_GLOBAL : 0,
});

// 本文保存は明示的なローカル診断時だけ。既定は無効。
import { appendFileSync } from "node:fs";
const DUMP_DIR = process.env.DUMP_DIR ?? "/tmp/codex-bridge-dumps";
if (process.env.ALLOW_REQUEST_DUMP === "1" && process.env.DISABLE_DUMP !== "1") {
  try { mkdirSync(DUMP_DIR, { recursive: true, mode: 0o700 }); } catch {}
}
function dump(body) {
  if (process.env.ALLOW_REQUEST_DUMP !== "1" || process.env.DISABLE_DUMP === "1") return;
  try {
    const file = `${DUMP_DIR}/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    appendFileSync(file, JSON.stringify({ at: Date.now(), body }, null, 2), { mode: 0o600 });
  } catch {}
}

// ------------------------------------------------------------ 変換

/** Responses API の input → chat/completions の messages */
function toChatMessages(body) {
  return chatMessages(body, reasoningOptions(body.model ?? DEFAULT_MODEL, body.reasoning?.effort).thinking?.type === "enabled");
}

/** Responses API の tools → chat/completions の tools */
function toChatTools(body) {
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  // Responses の組み込みツール（web_search 等）は chat API では表現できないので落とす
  const fns = tools
    .filter((t) => t.type === "function" || t.function)
    .map((t) => ({
      type: "function",
      function: t.function ?? {
        name: t.name,
        description: t.description ?? "",
        parameters: t.parameters ?? { type: "object", properties: {} },
      },
    }));

  return fns.length ? fns : undefined;
}

/** chat/completions のレスポンス → Responses API のレスポンス */
function toResponsesPayload(chat, model) {
  return chatToResponses(chat, model);
}

// ------------------------------------------------------------ SSE

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** chat/completions の stream を Responses API のイベント列に変換する */
async function pipeStream(upstreamRes, res, model, threadId) {
  return pipeChatStream(upstreamRes, res, model, threadId, { recordUsage });
}

// ------------------------------------------------------------ HTTP

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (!guardBridgeRequest(req, res)) return;
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  dbg(req.method, url.pathname);

  if (url.pathname === "/usage") {
    if (url.searchParams.has("json")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        total_cost_usd: Number(totalCost.toFixed(6)),
        threads: [...usageByThread.entries()].map(([id, u]) => ({ thread_id: id, ...u })),
      }, null, 2));
    } else {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderUsage());
    }
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, upstream: UPSTREAM_BASE, model: DEFAULT_MODEL }));
    return;
  }

  if (url.pathname === "/v1/models" || url.pathname === "/models") {
    // models.json から生成した全モデル一覧を返す
    try {
      const raw = readFileSync(new URL("./models.openai.json", import.meta.url), "utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(raw);
    } catch {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: DEFAULT_MODEL, object: "model", owned_by: "opencode-go" }] }));
    }
    return;
  }

  if (url.pathname === "/v1/responses" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid json" } }));
      return;
    }

    const authInfo = getToken();
    if (!authInfo.token) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "認証トークンがありません。OpenCode にログインするか OPENCODE_API_KEY を設定してください" } }));
      return;
    }

    dump(body);

    const model = body.model || DEFAULT_MODEL;
    const threadId = threadIdOf(body);
    const guard = requestGuard.check(threadId);
    if (!guard.allowed) {
      const scope = guard.scope === "global" ? "全体" : `スレッド ${String(threadId).slice(0, 8)}`;
      log(`!! 暴走ガード作動（${scope} / 1分間に ${guard.count} 回 / 上限 ${guard.limit}）。429 を返します`);
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": String(guard.retryAfterSeconds),
      });
      res.end(JSON.stringify({
        error: {
          type: "rate_limit_exceeded",
          message: `codex-bridge: ${guard.scope === "global" ? "全体で" : "このスレッドで"}1分間に ${guard.limit} 回を超えました。${guard.retryAfterSeconds} 秒後に再試行してください。`,
        },
      }));
      return;
    }

    const effort = body.reasoning?.effort ?? "medium";

    // Effort を実際の挙動に反映する。
    // 上流はモデルごとに reasoning_effort の扱いが違うため、
    // 指示文と temperature の両方で効かせる。
    const EFFORT_HINT = {
      none: "",
      minimal: "可能な限り短く答える。",
      low: "簡潔に、速さを優先して答える。",
      medium: "",
      high: "",
    };
    const EFFORT_TEMP = { none: 0.7, minimal: 0.7, low: 0.6, medium: 0.4, high: 0.2 };
    const hint = EFFORT_HINT[effort] ?? "";

    const messages = toChatMessages(body);
    if (hint) {
      const sys = messages.find((m) => m.role === "system");
      if (sys) sys.content = `${sys.content}\n\n${hint}`;
      else messages.unshift({ role: "system", content: hint });
    }

    const chatBody = {
      model,
      messages,
      tools: toChatTools(body),
      stream: Boolean(body.stream),
      temperature: EFFORT_TEMP[effort] ?? 0.4,
      stream_options: body.stream ? { include_usage: true } : undefined,
      frequency_penalty: 0.3,
      presence_penalty: 0.1,
      ...reasoningOptions(model, body.reasoning?.effort),
    };
    if (!chatBody.tools) delete chatBody.tools;
    if (body.max_output_tokens) chatBody.max_tokens = body.max_output_tokens;
    if (body.temperature != null) chatBody.temperature = body.temperature;
    if (body.tool_choice) chatBody.tool_choice = body.tool_choice;

    dbg("→", model, "messages:", chatBody.messages.length, "tools:", chatBody.tools?.length ?? 0);

    let upstream;
    const doFetch = (path, bodyObj) =>
      fetchOpenCode(`${UPSTREAM_BASE}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${authInfo.token}`,
          "content-type": "application/json",
          "user-agent": "codex-bridge/1.0",
          "x-opencode-session": upstreamSession(body, SESSION_ID),
        },
        body: JSON.stringify(bodyObj),
      });

    try {
      upstream = await doFetch("/chat/completions", chatBody);
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `upstream error: ${e.message}` } }));
      return;
    }

    // モデルによっては /responses しか受け付けない（gpt-6-luna / grok-4.7 など）。
    // その場合は元のリクエストをそのまま /responses に流す。
    if (upstream.status === 400) {
      const t = await upstream.clone().text();
      if (/ModelProtocolUnsupported|does not support this protocol/i.test(t)) {
        dbg("chat非対応 → /responses にフォールバック:", model);
        try {
          upstream = await doFetch("/responses", { ...body, model });
        } catch (e) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: `upstream error: ${e.message}` } }));
          return;
        }
        if (upstream.ok) {
          if (body.stream) {
            // Responses 形式のまま流す
            res.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            });
            const reader = upstream.body.getReader();
            let buf = "";
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = Buffer.from(value).toString("utf8");
              res.write(text);
              buf += text;
            }
            // 最終イベントから usage を拾う
            const m = buf.match(/"usage"\s*:\s*\{[^}]*"input_tokens"\s*:\s*(\d+)[^}]*"output_tokens"\s*:\s*(\d+)/);
            if (m) recordUsage(threadId, model, Number(m[1]), Number(m[2]));
            res.end();
          } else {
            // 既に Responses 形式なのでそのまま返す
            const payload = await upstream.text();
            res.writeHead(200, { "content-type": "application/json" });
            res.end(payload);
          }
          return;
        }
      }
    }

    if (!upstream.ok) {
      const t = await upstream.text();
      log("upstream", upstream.status);
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(t);
      return;
    }

    if (body.stream) {
      await pipeStream(upstream, res, model, threadId);
    } else {
      const chat = await upstream.json();
      if (chat.usage) recordUsage(threadId, model, chat.usage.prompt_tokens ?? 0, chat.usage.completion_tokens ?? 0);
      const payload = toResponsesPayload(chat, model);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    }
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not found" } }));
});

server.listen(PORT, "127.0.0.1", () => {
  log(`codex-bridge listening on http://127.0.0.1:${PORT}`);
  log(`upstream: ${UPSTREAM_BASE}`);
  const t = getToken(); log(`auth: ${t.kind}${t.token ? "" : " (トークンなし)"}`);
});
