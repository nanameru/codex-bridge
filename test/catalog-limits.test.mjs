import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildCatalog } from "../src/make-catalog.mjs";

const { models } = JSON.parse(readFileSync(new URL("../src/models.json", import.meta.url), "utf8"));
test("every OpenCode model compacts before the lower route limit", () => {
  const catalog = buildCatalog(models);
  for (const model of catalog.models) {
    assert.equal(model.auto_compact_token_limit, 500000);
    const effective = Math.min(model.auto_compact_token_limit, Math.floor(model.context_window * 0.9));
    assert.ok(effective <= 500000, model.slug);
  }
});

test("small-context models compact earlier through Codex's 90% clamp", () => {
  const catalog = buildCatalog(models);
  for (const model of catalog.models) {
    const ninetyPercent = Math.floor(model.context_window * 0.9);
    const effective = Math.min(model.auto_compact_token_limit, ninetyPercent);
    assert.equal(effective, ninetyPercent < 500000 ? ninetyPercent : 500000, model.slug);
  }
});
