import {
  closeSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

export const MAX_MODELS = 500;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const ANSI = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;

function cleanText(value, max, fallback) {
  if (typeof value !== "string") {
    if (fallback !== undefined) return fallback;
    throw new TypeError("文字列が必要です");
  }
  const text = value.replace(ANSI, "").replace(UNSAFE_TEXT, " ")
    .replace(/\s+/g, " ").trim().slice(0, max);
  return text || fallback || "";
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} が範囲外です`);
  }
  return value;
}

export function sanitizeText(value, max = 240) {
  const text = cleanText(value, max);
  if (!text) throw new Error("表示文字列が空です");
  return text;
}

export function validateModel(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("モデル定義が不正です");
  }
  if (typeof input.id !== "string" || !MODEL_ID.test(input.id)) {
    throw new Error("モデルIDが不正です");
  }
  const id = input.id;
  const ctx = integer(input.ctx, 1024, 10_000_000, "ctx");
  const out = integer(input.out, 1, ctx, "out");
  if (typeof input.vision !== "boolean") throw new TypeError("vision が不正です");
  if (!Array.isArray(input.efforts) || input.efforts.length === 0 || input.efforts.length > 8) {
    throw new Error("efforts が不正です");
  }
  const efforts = [];
  for (const effort of input.efforts) {
    if (typeof effort !== "string" || !EFFORTS.has(effort) || efforts.includes(effort)) {
      throw new Error("efforts に不正な値があります");
    }
    efforts.push(effort);
  }
  const compact = input.compact == null ? undefined
    : integer(input.compact, 1000, ctx, "compact");
  return {
    id,
    name: cleanText(input.name, 120, id),
    desc: cleanText(input.desc, 400, "説明未設定"),
    ctx,
    out,
    vision: input.vision,
    efforts,
    tier: cleanText(input.tier, 24, "balanced"),
    ...(compact === undefined ? {} : { compact }),
  };
}

export function validateModels(models) {
  if (!Array.isArray(models) || models.length === 0 || models.length > MAX_MODELS) {
    throw new Error("モデル一覧の件数が不正です");
  }
  const seen = new Set();
  return models.map((model) => {
    const validated = validateModel(model);
    if (seen.has(validated.id)) throw new Error("モデルIDが重複しています");
    seen.add(validated.id);
    return validated;
  });
}

export function providerEntries(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("models.dev の応答が不正です");
  }
  const provider = payload["opencode-go"];
  if (!provider || typeof provider !== "object" || !provider.models
      || typeof provider.models !== "object" || Array.isArray(provider.models)) {
    throw new Error("opencode-go のモデル一覧がありません");
  }
  const entries = Object.entries(provider.models);
  if (entries.length === 0 || entries.length > MAX_MODELS) {
    throw new Error("opencode-go のモデル件数が不正です");
  }
  for (const [id, model] of entries) {
    if (!MODEL_ID.test(id) || !model || typeof model !== "object" || Array.isArray(model)) {
      throw new Error("models.dev のモデル定義が不正です");
    }
    if (model.name !== undefined && typeof model.name !== "string") {
      throw new Error("models.dev のモデル名が不正です");
    }
    if (model.limit !== undefined && (!model.limit || typeof model.limit !== "object")) {
      throw new Error("models.dev の limit が不正です");
    }
    if (model.modalities !== undefined
        && (!model.modalities || typeof model.modalities !== "object")) {
      throw new Error("models.dev の modalities が不正です");
    }
    const input = model.modalities?.input;
    if (input !== undefined && (!Array.isArray(input) || input.some((item) => typeof item !== "string"))) {
      throw new Error("models.dev の入力modalitiesが不正です");
    }
  }
  return entries;
}

export function writeFileAtomic(file, text, mode = 0o600) {
  const current = lstatSync(file, { throwIfNoEntry: false });
  if (current?.isSymbolicLink()) throw new Error("シンボリックリンク先へは書き込みません");
  const temporary = join(dirname(file),
    `.${basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeSync(descriptor, text);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    try { unlinkSync(temporary); } catch {}
  }
}
