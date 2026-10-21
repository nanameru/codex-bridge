import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildCatalog } from "../src/make-catalog.mjs";

const { models } = JSON.parse(readFileSync(new URL("../src/models.json", import.meta.url), "utf8"));
const longSessionModels = ["deepseek-v4.1-flash", "deepseek-v4-pro"];

test("DeepSeek models compact before the lower OpenCode Go route limit", () => {
  const catalog = buildCatalog(models);
  for (const slug of longSessionModels) {
    const model = catalog.models.find((candidate) => candidate.slug === slug);
    assert.ok(model, slug);
    assert.equal(model.context_window, 1000000);
    assert.equal(model.auto_compact_token_limit, 500000);
    assert.ok(model.auto_compact_token_limit < 582016);
  }
});

test("other models keep Codex's default automatic compaction", () => {
  const catalog = buildCatalog(models);
  for (const model of catalog.models) {
    if (longSessionModels.includes(model.slug)) continue;
    assert.equal(model.auto_compact_token_limit, null, model.slug);
  }
});
