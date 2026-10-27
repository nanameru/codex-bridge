/** Local trust boundary shared by both services. Never logs or forwards credentials. */
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

export function readPrivateFile(root, name, forbiddenMode = 0o077) {
  let descriptor;
  try {
    const parent = lstatSync(root);
    if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o022)) return null;
    descriptor = openSync(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & forbiddenMode) || info.nlink !== 1
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

const settingsCache = new Map();
function credentialSettings(root) {
  let source = readPrivateFile(root, "config.toml", 0o022);
  if (source === null) {
    // Only an absent config means defaults; unreadable/unsafe configs fail closed.
    try { lstatSync(join(root, "config.toml")); return null; }
    catch (error) { if (error.code !== "ENOENT") return null; }
    source = "";
  }
  if (!source.trim()) return { store: "file" };
  const digest = createHash("sha256").update(source).digest("hex");
  if (settingsCache.has(digest)) {
    const settings = settingsCache.get(digest);
    settingsCache.delete(digest);
    settingsCache.set(digest, settings);
    return settings;
  }
  // Use the same TOML parser as our setup tools; never send config to a service.
  let settings = null;
  try {
    settings = JSON.parse(execFileSync("python3", ["-c",
      'import sys,json,tomllib; c=tomllib.loads(sys.stdin.read()); print(json.dumps({"store":c.get("cli_auth_credentials_store","file")}))'],
    { input: source, encoding: "utf8", timeout: 3000, maxBuffer: 65536, stdio: ["pipe", "pipe", "ignore"] }));
  } catch { /* Invalid TOML or missing Python is diagnosed without exposing config. */ }
  if (settingsCache.size >= 32) settingsCache.delete(settingsCache.keys().next().value);
  settingsCache.set(digest, settings);
  return settings;
}

function macKeychainRead(service, account) {
  return execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"],
    { encoding: "utf8", timeout: 3000, maxBuffer: 65536, stdio: ["ignore", "pipe", "ignore"] });
}

/** Read only the caller's Codex store. Never scan other users, homes or keychains. */
export function readCodexAuth(root = codexRoot(), { platform = process.platform, keychainRead = macKeychainRead } = {}) {
  const rejected = (reason, store = "unknown") => ({ auth: null, reason, store });
  try {
    const info = lstatSync(root);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022)) return rejected("unsafe_codex_home");
    const settings = credentialSettings(root);
    if (!settings) return rejected("credential_config_invalid");
    const { store } = settings;
    if (!["file", "keyring", "auto"].includes(store)) return rejected("unsupported_credential_store");
    let serialized;
    let usedStore = "file";
    if (store !== "file") {
      if (platform !== "darwin" && store === "keyring") return rejected("keyring_platform_unsupported", store);
      if (platform === "darwin") {
        try {
          const account = "cli|" + createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 16);
          serialized = keychainRead("Codex Auth", account);
          if (serialized) usedStore = "keyring";
        } catch { if (store === "keyring") return rejected("keyring_unavailable", store); }
      }
      if (!serialized && store === "keyring") return rejected("keyring_unavailable", store);
    }
    if (!serialized) serialized = readPrivateFile(root, "auth.json");
    if (serialized === null) return rejected("auth_file_unavailable", usedStore);
    let auth;
    try { auth = JSON.parse(serialized); }
    catch { return rejected("credential_invalid", usedStore); }
    const expected = auth?.tokens?.access_token ?? auth?.OPENAI_API_KEY;
    if (typeof expected !== "string" || !expected) return rejected("credential_missing", usedStore);
    if (auth?.tokens?.access_token && expected.split(".").length === 3) {
      let claims;
      try { claims = JSON.parse(Buffer.from(expected.split(".")[1], "base64url").toString("utf8")); }
      catch { return rejected("credential_invalid", usedStore); }
      if (!Number.isFinite(claims?.exp) || claims.exp <= Date.now() / 1000) return rejected("credential_expired", usedStore);
    }
    return { auth, reason: null, store: usedStore };
  } catch { return rejected("credential_unavailable"); }
}

export function diagnoseCodexAuth(root = codexRoot(), options) {
  const { auth, reason, store } = readCodexAuth(root, options);
  return { ok: auth !== null, store, reason };
}

export const LOCAL_AUTH_HELP = "利用者本人のCodex認証を確認できません。CodexとBridgeのCODEX_HOME・認証保存方式・有効期限・ファイル権限を確認してください。配布元の認証情報は不要です。Bridgeリポジトリで診断: node src/auth-doctor.mjs";

export function authenticateCodex(request, root = codexRoot(), options) {
  const bearer = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
  if (!bearer) return false;
  const { auth } = readCodexAuth(root, options);
  return sameSecret(bearer, auth?.tokens?.access_token ?? auth?.OPENAI_API_KEY);
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
    response.end(JSON.stringify({ error: { type: "local_authentication_required", message: localError ? "ローカルCLI接続だけを受け付けます" : LOCAL_AUTH_HELP } }));
    return false;
  }
  return true;
}
