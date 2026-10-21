import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  providerEntries, sanitizeText, validateModel, validateModels, writeFileAtomic,
} from "../src/catalog-safety.mjs";
import { buildCatalog } from "../src/make-catalog.mjs";
import { fetchEntries, mergeRemoteModels, parsePayload } from "../src/sync-models.mjs";

const base = {
  id: "safe-model",
  name: "Safe",
  desc: "Desc",
  ctx: 1_000_000,
  out: 32_000,
  vision: true,
  efforts: ["low", "medium", "high"],
  tier: "fast",
};

test("strips terminal controls and bidirectional overrides from display text", () => {
  assert.equal(sanitizeText("A\u001b[31mB\u202eC"), "AB C");
  assert.throws(() => sanitizeText("\u0000\n"), /空/);
});

test("rejects malformed model ids, ranges, efforts and compact limits", () => {
  for (const change of [
    { id: "../escape" },
    { ctx: 0 },
    { out: 2_000_000 },
    { vision: "yes" },
    { efforts: ["low", "low"] },
    { efforts: ["unknown"] },
    { compact: 2_000_000 },
  ]) {
    assert.throws(() => validateModel({ ...base, ...change }), undefined, JSON.stringify(change));
  }
  assert.throws(() => validateModels([base, { ...base }]), /重複/);
});

test("validates the generated catalog and sanitizes remote display names", () => {
  const catalog = buildCatalog([{ ...base, name: "A\u001b[31mB" }]);
  assert.equal(catalog.models[0].display_name, "AB");
  assert.equal(catalog.models[0].priority, 1);
});

test("writes atomically, restricts home catalog permissions and refuses symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "catalog-safety-"));
  try {
    const target = join(directory, "catalog.json");
    writeFileAtomic(target, "first", 0o600);
    assert.equal(readFileSync(target, "utf8"), "first");
    assert.equal(statSync(target).mode & 0o777, 0o600);
    const victim = join(directory, "victim");
    writeFileSync(victim, "keep");
    const link = join(directory, "link.json");
    symlinkSync(victim, link);
    assert.throws(() => writeFileAtomic(link, "overwritten", 0o600), /シンボリックリンク/);
    assert.equal(readFileSync(victim, "utf8"), "keep");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects invalid provider payloads and preserves local compact settings", () => {
  const valid = { "opencode-go": { models: {
    "safe-model": { name: "\u001b[31mNew", limit: { context: 200_000, output: 10_000 },
      modalities: { input: ["text", "image"] } },
    "new-model": { name: "New model", limit: { context: 200_000, output: 10_000 } },
  } } };
  assert.equal(providerEntries(valid)[0][0], "safe-model");
  assert.throws(() => providerEntries({}), /opencode-go/);
  assert.throws(() => providerEntries({ "opencode-go": { models: {
    "../bad": { name: "Bad" },
  } } }), /モデル定義/);
  assert.throws(() => providerEntries({ "opencode-go": { models: {
    "bad-modal": { modalities: { input: "image" } },
  } } }), /modalities/);

  const merged = mergeRemoteModels([{ ...base, compact: 500_000 }], Object.entries(valid["opencode-go"].models));
  const safe = merged.models.find((model) => model.id === "safe-model");
  assert.equal(safe.name, "New");
  assert.equal(safe.compact, 200_000);
  assert.equal(safe.vision, true);
  assert.deepEqual(merged.created, ["new-model"]);
});

test("parse and fetch failures are explicit and bounded", async () => {
  assert.throws(() => parsePayload("not-json"), /JSON/);
  await assert.rejects(fetchEntries(async () => ({ ok: false, status: 503 })), /HTTP 503/);
  await assert.rejects(fetchEntries(async () => ({
    ok: true, headers: { get: () => String(11 * 1024 * 1024) }, text: async () => "{}",
  })), /大きすぎます/);
});

test("make-catalog refuses to overwrite a symlinked home catalog", () => {
  const directory = mkdtempSync(join(tmpdir(), "catalog-home-"));
  const previousHome = process.env.HOME;
  try {
    mkdirSync(join(directory, ".codex"));
    const victim = join(directory, "victim");
    writeFileSync(victim, "keep");
    symlinkSync(victim, join(directory, ".codex", "model-catalog.json"));
    process.env.HOME = directory;
    const result = spawnSync(process.execPath, ["src/make-catalog.mjs"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(victim, "utf8"), "keep");
  } finally {
    process.env.HOME = previousHome;
    rmSync(directory, { recursive: true, force: true });
  }
});
