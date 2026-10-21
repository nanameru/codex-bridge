#!/usr/bin/env node
/**
 * models.dev から OpenCode Go のモデル情報を取得し、models.json を更新する。
 *   node sync-models.mjs
 *
 * - 画像対応 / コンテキスト長 / 最大出力 を実データに合わせる
 * - 説明文と tier は手書きのものを保持する（新規モデルは既定文）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const path = join(here, "models.json");
const local = JSON.parse(readFileSync(path, "utf8"));
const byId = new Map(local.models.map((m) => [m.id, m]));

const res = await fetch("https://models.dev/api.json");
const all = await res.json();
const prov = all["opencode-go"];
if (!prov) throw new Error("opencode-go が見つかりません");

const created = [];
const models = Object.entries(prov.models).map(([id, m]) => {
  const cur = byId.get(id) ?? {};
  if (!cur.id) created.push(id);
  const vision = (m.modalities?.input ?? []).includes("image");
  return {
    id,
    name: m.name ?? cur.name ?? id,
    desc: cur.desc ?? "説明未設定",
    ctx: m.limit?.context ?? cur.ctx ?? 128000,
    out: m.limit?.output ?? cur.out ?? 32000,
    vision,
    efforts: cur.efforts ?? ["low", "medium", "high"],
    tier: cur.tier ?? (vision ? "balanced" : "fast"),
    ...(cur.compact == null ? {} : { compact: cur.compact }),
  };
});

writeFileSync(path, JSON.stringify({ models }, null, 2));
console.log(`models.json 更新: ${models.length} モデル（新規 ${created.length}）`);
if (created.length) console.log("新規:", created.join(", "));
