/** Local trust boundary shared by both services. Never logs or forwards credentials. */
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const INTERNAL_AUTH_HEADER = "x-codex-bridge-auth";
export const SECURITY_VERSION = "local-owner-v1";
export const codexRoot = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");

export function validateOpenCodeBase(value, allowLoopbackTest = process.env.CODEX_BRIDGE_TEST_UPSTREAM === "1") {
  const url = new URL(value);
  const official = url.origin === "https://opencode.ai" && url.pathname === "/inference/go/openai/v1";
  const test = allowLoopbackTest && url.protocol === "http:" && url.hostname === "127.0.0.1";
  if ((!official && !test) || url.username || url.password || url.search || url.hash) {
    throw new Error("OpenCode認証の送信先を確認してください（公式Go APIのみ）");
  }
  return value;
}

export async function fetchOpenCode(url, options, fetcher = fetch) {
  const response = await fetcher(url, { ...options, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error("OpenCode upstream redirect rejected");
  }
  return response;
}

export function readPrivateFile(root, name) {
  let descriptor;
  try {
    const parent = lstatSync(root);
    if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o022)) return null;
    descriptor = openSync(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.nlink !== 1
        || info.size > 64 * 1024) return null;
    return readFileSync(descriptor, "utf8");
  } catch { return null; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function sameSecret(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string" || !received || !expected) return false;
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(received), digest(expected));
}

export function authenticateCodex(request, root = codexRoot()) {
  const bearer = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
  if (!bearer) return false;
  try {
    const auth = JSON.parse(readPrivateFile(root, "auth.json"));
    const expected = auth?.tokens?.access_token ?? auth?.OPENAI_API_KEY;
    if (!sameSecret(bearer, expected)) return false;
    if (auth?.tokens?.access_token && expected.split(".").length === 3) {
      const claims = JSON.parse(Buffer.from(expected.split(".")[1], "base64url").toString("utf8"));
      if (typeof claims.exp !== "number" || claims.exp <= Date.now() / 1000) return false;
    }
    return true;
  } catch { return false; }
}

export function readBridgeKey(root = codexRoot()) {
  const value = readPrivateFile(root, "bridge-local-token")?.trim();
  return /^[a-f0-9]{64}$/.test(value ?? "") ? value : null;
}

export function readOpenCodeApiKey({ environment = process.env, home = homedir() } = {}) {
  if (environment.OPENCODE_API_KEY) return environment.OPENCODE_API_KEY;
  try {
    const auth = JSON.parse(readPrivateFile(join(home, ".local/share/opencode"), "auth.json"))?.["opencode-go"];
    return auth?.type === "api" && typeof auth.key === "string" && auth.key ? auth.key : null;
  } catch { return null; }
}

export function authenticateBridge(request, root = codexRoot()) {
  return sameSecret(request.headers[INTERNAL_AUTH_HEADER], readBridgeKey(root)) || authenticateCodex(request, root);
}

export function localRequestError(request) {
  // CLI requests have no Origin. Reject browser origins, including "null".
  if (request.headers.origin !== undefined || request.headers["sec-fetch-site"] !== undefined) return 403;
  const address = request.socket.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) return 403;
  const port = request.socket.localPort;
  if (![ `127.0.0.1:${port}`, `[::1]:${port}` ].includes(request.headers.host)) return 403;
  if (!request.url.startsWith("/") || request.url.startsWith("//")) return 403;
  return null;
}

export function guardBridgeRequest(request, response) {
  const localError = localRequestError(request);
  const pathname = localError ? null : new URL(request.url, "http://127.0.0.1").pathname;
  if (!localError && request.method === "GET" && pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ ok: true, security: SECURITY_VERSION,
      implementation: process.env.CODEX_BRIDGE_SECURITY_REVISION,
      request_dump: process.env.ALLOW_REQUEST_DUMP === "1" && process.env.DISABLE_DUMP !== "1" }));
    return false;
  }
  if (localError || !authenticateBridge(request)) {
    response.writeHead(localError ?? 401, { "content-type": "application/json", "connection": "close", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: { type: "local_authentication_required", message: "本人用ローカル接続だけを受け付けます" } }));
    return false;
  }
  return true;
}
