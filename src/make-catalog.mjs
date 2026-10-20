#!/usr/bin/env node
/**
 * models.json から Codex のモデルカタログ（ModelInfo 形式）を生成する。
 *   node make-catalog.mjs
 *
 * 出力:
 *   ~/.codex/model-catalog.json   … Codex の model_catalog_json
 *   ./models.openai.json          … codex-bridge の /v1/models
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { models } = JSON.parse(readFileSync(join(here, "models.json"), "utf8"));

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

const catalog = {
  models: models.map((m, i) => ({
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
    priority: i + 1,
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
    auto_compact_token_limit: null,
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

const out = join(homedir(), ".codex", "model-catalog.json");
writeFileSync(out, JSON.stringify(catalog, null, 2));
console.log(`書き出し: ${out} (${catalog.models.length} モデル)`);

const openai = {
  object: "list",
  data: models.map((m) => ({
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
writeFileSync(join(here, "models.openai.json"), JSON.stringify(openai, null, 2));
console.log("書き出し: models.openai.json");
