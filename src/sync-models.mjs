#!/usr/bin/env node
/**
 * models.dev から OpenCode Go のモデル情報を取得し、models.json を更新する。
 *   node sync-models.mjs
 *
 * - 画像対応 / コンテキスト長 / 最大出力 を実データに合わせる
 * - 説明文と tier は手書きのものを保持する（新規モデルは既定文）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { providerEntries, validateModels, writeFileAtomic } from "./catalog-safety.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const path = join(here, "models.json");
const SOURCE = "https://models.dev/api.json";
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export function mergeRemoteModels(localModels, entries) {
  const byId = new Map(localModels.map((model) => [model.id, model]));
  const created = [];
  const models = entries.map(([id, remote]) => {
    const current = byId.get(id) ?? {};
    if (!current.id) created.push(id);
    const vision = Array.isArray(remote.modalities?.input) && remote.modalities.input.includes("image");
    const remoteContext = remote.limit?.context;
    const context = Number.isSafeInteger(remoteContext) && remoteContext >= 1024
      && remoteContext <= 10_000_000 ? remoteContext : current.ctx ?? 128000;
    const remoteOutput = remote.limit?.output;
    const output = Number.isSafeInteger(remoteOutput) && remoteOutput >= 1 && remoteOutput <= context
      ? remoteOutput : current.out ?? 32000;
    const compact = current.compact == null ? undefined : Math.min(current.compact, context);
    return {
      id,
      name: typeof remote.name === "string" ? remote.name : current.name ?? id,
      desc: current.desc ?? "説明未設定",
      ctx: context,
      out: output,
      vision,
      efforts: current.efforts ?? ["low", "medium", "high"],
      tier: current.tier ?? (vision ? "balanced" : "fast"),
      ...(compact === undefined ? {} : { compact }),
    };
  });
  return { models: validateModels(models), created };
}

export function parsePayload(text) {
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error("models.dev の応答が大きすぎます");
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("models.dev の応答がJSONではありません");
  }
  return providerEntries(payload);
}

export async function fetchEntries(fetcher = fetch) {
  const response = await fetcher(SOURCE, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`models.dev の取得に失敗しました: HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new Error("models.dev の応答が大きすぎます");
  }
  return parsePayload(await response.text());
}

async function main() {
  const local = validateModels(JSON.parse(readFileSync(path, "utf8")).models);
  const { models, created } = mergeRemoteModels(local, await fetchEntries());
  writeFileAtomic(path, JSON.stringify({ models }, null, 2), 0o644);
  console.log(`models.json 更新: ${models.length} モデル（新規 ${created.length}）`);
  if (created.length) console.log("新規:", created.join(", "));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`models.json を更新できません: ${error.message}`);
    process.exitCode = 1;
  });
}
