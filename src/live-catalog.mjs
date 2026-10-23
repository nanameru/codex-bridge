import { createHash } from "node:crypto";
import { buildCatalog } from "./make-catalog.mjs";
import { mergeRemoteModels, parsePayload } from "./sync-models.mjs";
import { validateModels } from "./catalog-safety.mjs";

const GO_MODELS = "https://opencode.ai/inference/go/v1/models";
const METADATA = "https://models.dev/api.json";
const NATIVE_MODELS = "https://chatgpt.com/backend-api/codex/models";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export async function boundedJSON(response, limit) {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("catalog_http_error"); }
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("catalog_too_large");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}

export function discoveredModels(payload, entries, seed) {
  if (!Array.isArray(payload?.data) || payload.data.length < 1 || payload.data.length > 500) throw new Error("catalog_invalid");
  const seen = new Set();
  const metadata = new Map(entries);
  const available = payload.data.map(m => {
    if (!ID.test(m?.id ?? "") || seen.has(m.id)) throw new Error("catalog_invalid");
    seen.add(m.id);
    return [m.id, metadata.get(m.id) ?? {}];
  });
  const models = mergeRemoteModels(seed, available).models.map(model => {
    const remote = metadata.get(model.id);
    const efforts = remote?.reasoning_options?.find(option => option.type === "effort")?.values;
    const choices = Array.isArray(efforts) && efforts.length && efforts.every(e => EFFORTS.has(e))
      ? [...new Set(efforts)] : model.efforts;
    return { ...model, efforts: choices, compact: Math.min(model.compact ?? 500000, Math.floor(model.ctx * 0.8)) };
  });
  return buildCatalog(validateModels(models)).models.map(model => ({ ...model,
    slug: "opencode/" + model.slug, display_name: "OpenCode · " + model.display_name,
    router_provider: "opencode", router_model: model.slug, router_transport: "chat" }));
}

export function createLiveCatalog({ initial, seed, fetcher = fetch, key, now = Date.now,
  ttlMs = 300000, retryMs = 30000, onUpdate = () => {}, onStatus = () => {} }) {
  let go = initial.models.filter(m => m.router_provider === "opencode");
  let goDue = 0; let goJob; let goIdentity;
  let metadataEntries = []; let metadataDue = 0;
  const native = new Map();
  const report = status => { try { onStatus(status); } catch {} };
  const getJSON = async (url, headers, limit) => boundedJSON(await fetcher(url, {
    headers: { accept: "application/json", "user-agent": "codex-bridge/1.0", ...headers },
    redirect: "error", signal: AbortSignal.timeout(10000),
  }), limit);
  async function refreshGo() {
    const token = key();
    if (!token) { report("go_key_missing"); return; }
    const identity = createHash("sha256").update(token).digest("hex");
    if (identity !== goIdentity) { goIdentity = identity; goDue = 0; }
    if (now() < goDue) return;
    if (goJob) return goJob;
    goJob = (async () => {
      try {
        const payload = await getJSON(GO_MODELS, { authorization: "Bearer " + token }, 1024 * 1024);
        const previous = new Set(go.map(m => m.router_model));
        const newIds = Array.isArray(payload?.data) && payload.data.some(m => !previous.has(m?.id));
        if (now() >= metadataDue || newIds) {
          try {
            metadataEntries = parsePayload(JSON.stringify(await getJSON(METADATA, {}, 10 * 1024 * 1024)));
            metadataDue = now() + 3600000;
          } catch { metadataDue = now() + retryMs; report("metadata_unavailable"); }
        }
        const candidate = discoveredModels(payload, metadataEntries, seed);
        // Commit the complete validated snapshot only after every entry passes.
        go = candidate; goDue = now() + ttlMs; report("go_updated");
      } catch { goDue = now() + retryMs; report("go_refresh_failed"); }
    })().finally(() => { goJob = undefined; });
    return goJob;
  }
  return {
    async get(headers, version) {
      if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("catalog_client_version_required");
      const auth = headers.authorization;
      if (typeof auth !== "string" || !/^Bearer \S+$/i.test(auth)) throw new Error("catalog_auth_required");
      const account = headers["chatgpt-account-id"];
      const identity = createHash("sha256").update(auth).update("\0").update(account ?? "").update("\0")
        .update(headers.originator ?? "").update("\0").update(version).digest("hex");
      let entry = native.get(identity);
      if (!entry) {
        if (native.size >= 8) native.delete(native.keys().next().value);
        entry = { due: 0 }; native.set(identity, entry);
      }
      const nativeHeaders = { authorization: auth };
      if (typeof account === "string") nativeHeaders["chatgpt-account-id"] = account;
      for (const name of ["originator", "version", "user-agent"]) {
        if (typeof headers[name] === "string") nativeHeaders[name] = headers[name];
      }
      if (now() >= entry.due && !entry.job) {
        entry.job = (async () => {
          try {
            const data = await getJSON(NATIVE_MODELS + "?client_version=" + version, nativeHeaders, 1024 * 1024);
            if (!Array.isArray(data?.models) || !data.models.length || data.models.length > 500) throw new Error("catalog_invalid");
            const ids = new Set();
            const models = data.models.map(m => {
              if (!ID.test(m?.slug ?? "") || ids.has(m.slug)) throw new Error("catalog_invalid");
              ids.add(m.slug);
              return { ...m, router_provider: "openai", router_model: m.slug };
            });
            entry.models = models; entry.due = now() + ttlMs;
          } catch { entry.due = now() + retryMs; report("native_refresh_failed"); }
        })().finally(() => { entry.job = undefined; });
      }
      await Promise.all([entry.job, refreshGo()]);
      if (!entry.models) throw new Error("native_catalog_unavailable");
      const catalog = { models: [...entry.models, ...go] };
      if (Buffer.byteLength(JSON.stringify(catalog)) > 1024 * 1024) throw new Error("catalog_too_large");
      onUpdate(catalog);
      return catalog;
    },
  };
}
