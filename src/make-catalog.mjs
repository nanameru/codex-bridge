#!/usr/bin/env node
/**
 * models.json から Codex のモデルカタログ（ModelInfo 形式）を生成する。
 *   node make-catalog.mjs
 *
 * 出力:
 *   ~/.codex/model-catalog.json   … Codex の model_catalog_json
 *   ./models.openai.json          … codex-bridge の /v1/models
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateModels, writeFileAtomic } from "./catalog-safety.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PINNED = ["deepseek-v4.1-flash"];
const DEFAULT_AUTO_COMPACT_TOKEN_LIMIT = 500000;

const effortDesc = {
  low: "速さ優先。短い修正や単純作業",
  medium: "標準。バランス重視",
  high: "精度優先。時間をかけて考える",
};

const INSTRUCTIONS = [
  "You are Codex, a coding agent running in the user's terminal on macOS.",
  "Work autonomously, use the provided tools, and prefer small verified steps.",
  "Answer in Japanese unless the user writes in another language.",
].join(" ");

export function orderModels(models) {
  const pinnedOrder = new Map(PINNED.map((id, index) => [id, index]));
  const ordered = models.map((model, index) => ({ model, index }))
    .sort((a, b) => {
      const aPinned = pinnedOrder.has(a.model.id);
      const bPinned = pinnedOrder.has(b.model.id);
      if (aPinned && bPinned) return pinnedOrder.get(a.model.id) - pinnedOrder.get(b.model.id);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ model }) => model);
  const priorities = new Map();
  let nextPriority = PINNED.some((id) => models.some((model) => model.id === id)) ? 2 : 1;
  for (const model of ordered) {
    if (pinnedOrder.has(model.id)) priorities.set(model.id, 1);
    else {
      priorities.set(model.id, nextPriority);
      nextPriority += 1;
    }
  }
  return { ordered, priorities };
}

export function buildCatalog(models) {
  const safeModels = validateModels(models);
  const { ordered, priorities } = orderModels(safeModels);
  return {
    models: ordered.map((m) => ({
      slug: m.id,
      base_instructions: INSTRUCTIONS,
      display_name: m.name,
      description: m.desc,
      default_reasoning_level: m.efforts.includes("medium") ? "medium" : m.efforts[0],
      supported_reasoning_levels: m.efforts.map((e) => ({
        effort: e,
        description: effortDesc[e] ?? e,
      })),
      shell_type: "default",
      visibility: "list",
      supported_in_api: true,
      priority: priorities.get(m.id),
      additional_speed_tiers: [],
      service_tiers: [],
      default_service_tier: null,
      available_access_programs: null,
      availability_nux: null,
      upgrade: null,
      include_skills_usage_instructions: true,
      include_plugin_usage_instructions: true,
      include_apps_usage_instructions: true,
      supports_reasoning_summary_parameter: false,
      default_reasoning_summary: "auto",
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text_and_image",
      truncation_policy: { mode: "bytes", limit: 10000 },
      supports_image_detail_original: Boolean(m.vision),
      context_window: m.ctx,
      max_context_window: m.ctx,
      auto_compact_token_limit: m.compact ?? DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
      effective_context_window_percent: 95,
      experimental_supported_tools: ["computer_use", "browser_use", "web_search"],
      comp_hash: null,
      input_modalities: m.vision ? ["text", "image"] : ["text"],
      supports_search_tool: false,
      supports_experimental_context: false,
      use_responses_lite: false,
      supports_reasoning_effort_updates: false,
      node_repl_auto_review_required: false,
      node_repl_disabled: false,
      model_specialty: m.tier,
      tool_mode: null,
      multi_agent_version: null,
      multi_agent_reasoning_effort: null,
    })),
  };
}

export function buildOpenAIModels(models) {
  const { ordered } = orderModels(validateModels(models));
  return {
    object: "list",
    data: ordered.map((m) => ({
      id: m.id,
      object: "model",
      created: 0,
      owned_by: "opencode-go",
      display_name: m.name,
      description: m.desc,
      context_window: m.ctx,
      supported_reasoning_efforts: m.efforts,
    })),
  };
}

function main() {
  const { models } = JSON.parse(readFileSync(join(here, "models.json"), "utf8"));
  const catalog = buildCatalog(models);
  const out = join(homedir(), ".codex", "model-catalog.json");
  writeFileAtomic(out, JSON.stringify(catalog, null, 2), 0o600);
  console.log(`書き出し: ${out} (${catalog.models.length} モデル)`);
  writeFileAtomic(join(here, "models.openai.json"), JSON.stringify(buildOpenAIModels(models), null, 2), 0o644);
  console.log("書き出し: models.openai.json");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
