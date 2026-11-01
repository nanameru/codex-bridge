/** Shared model identities: only namespace/case normalization, never version aliases. */
export const COMMAND_MODELS_URL = 'https://api.commandcode.ai/provider/v1/models';
export const commandIdentity = id => typeof id === 'string' ? id.split('/').at(-1).toLowerCase() : '';
export const SHARED_PROVIDERS = Object.freeze(['opencode', 'commandcode']);
// Public API snapshot, 2026-11-01. Live refresh replaces it atomically.
export const COMMAND_MODEL_SEED = [
  {"id":"gpt-6-astra","context_length":1050000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"gpt-6.1-sol","context_length":1050000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"gpt-6.1-terra","context_length":1050000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"gpt-6-sol","context_length":1050000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"gpt-6-luna","context_length":1050000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"gpt-5.6-sol","context_length":1050000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"gpt-5.6-terra","context_length":1050000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"gpt-5.6-luna","context_length":1050000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"gpt-5.5","context_length":400000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"gpt-5.4","context_length":400000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"gpt-5.3-codex","context_length":400000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"gpt-5.4-mini","context_length":400000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"deepseek/deepseek-v4-pro","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"deepseek/deepseek-v4-flash","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"deepseek/deepseek-v4-flash-vision-exp","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"deepseek/deepseek-v4-flash-fast","context_length":1000000,"supported_endpoints":["/chat/completions"]},
  {"id":"deepseek/deepseek-v4.1-flash","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"deepseek/deepseek-v4.1-flash-fast","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"moonshotai/Kimi-K3.1-Pro","context_length":1048576,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"moonshotai/Kimi-K3","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"moonshotai/Kimi-K2.7-Code","context_length":256000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"moonshotai/Kimi-K2.7-Code-Highspeed","context_length":262000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"moonshotai/Kimi-K2.6","context_length":256000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"moonshotai/Kimi-K2.5","context_length":256000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"z-ai/glm-5.3-flash","context_length":1048576,"supported_endpoints":["/chat/completions"]},
  {"id":"z-ai/glm-5.3-flashx","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"zai-org/GLM-5.3","context_length":1000000,"supported_endpoints":["/chat/completions"]},
  {"id":"zai-org/GLM-5.2","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"zai-org/GLM-5.2-Fast","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"zai-org/GLM-5.1","context_length":200000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"zai-org/GLM-5","context_length":200000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"minimax/minimax-m3.1-flash","context_length":1000000,"supported_endpoints":["/chat/completions"]},
  {"id":"MiniMaxAI/MiniMax-M3","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"MiniMaxAI/MiniMax-M2.7","context_length":200000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"MiniMaxAI/MiniMax-M2.5","context_length":200000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"ornith/ornith-1.5-122b","context_length":262144,"supported_endpoints":["/chat/completions"]},
  {"id":"xiaomi/mimo-v2.6-pro","context_length":1048576,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"xiaomi/mimo-v2.6-pro-ultraspeed","context_length":1048576,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"xiaomi/mimo-v2.6-flash","context_length":1048576,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"Qwen/Qwen3.8-Omni-Flash","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"Qwen/Qwen3.8-Max-Prime","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"Qwen/Qwen3.8-Max-0902","context_length":1000000,"supported_endpoints":["/chat/completions"]},
  {"id":"Qwen/Qwen3.8-Max","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"Qwen/Qwen3.8-27B","context_length":262144,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"Qwen/Qwen3.8-Flash","context_length":1000000,"supported_endpoints":["/chat/completions"]},
  {"id":"Qwen/Qwen3.7-Max","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"Qwen/Qwen3.7-Plus","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"Qwen/Qwen3.7-Flash","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"Qwen/Qwen3.6-Max-Preview","context_length":200000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"Qwen/Qwen3.6-Plus","context_length":200000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"meituan/LongCat-2.0","context_length":1048576,"supported_endpoints":["/chat/completions"]},
  {"id":"stepfun/Step-5-Preview","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"stepfun/Step-3.7-Flash","context_length":256000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"stepfun/Step-3.5-Flash","context_length":262144,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"tencent/hy3-paid","context_length":262144,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"tencent/hy4-preview","context_length":1048576,"supported_endpoints":["/chat/completions"]},
  {"id":"google/gemini-4-argon","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"google/gemini-3.8-flash","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"google/gemini-3.7-flash","context_length":1048576,"supported_endpoints":["/chat/completions"]},
  {"id":"google/gemini-3.6-flash","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"google/gemini-3.5-flash","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"google/gemini-3.5-flash-lite","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"google/gemini-3.1-flash-lite","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"sakana/fugu-ultra","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"nvidia/nemotron-3-ultra-550b-a55b","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"nvidia/nemotron-3.5-super-vl","context_length":262144,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"thinkingmachines/inkling","context_length":256000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"thinkingmachines/inkling-small","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"stealth/glyph-cluster:free","context_length":256000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"reflection/beam:free","context_length":1048576,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"poolside/laguna-s-2.1-free","context_length":256000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"inclusionai/ling-3.1-flash","context_length":262144,"supported_endpoints":["/chat/completions"]},
  {"id":"inclusionai/ling-3.1-flash-1019:free","context_length":1000000,"supported_endpoints":["/chat/completions"]},
  {"id":"meta/muse-spark-1.1","context_length":1048576,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"meta/muse-spark-1.2","context_length":1048576,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"meta/muse-spark-1.2-contributor","context_length":1048576,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"meta/muse-spark-1.3","context_length":1048576,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"meta/muse-spark-1.3-contributor","context_length":1048576,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"meta/muse-spark-open","context_length":1048576,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"meta/muse-wonder-1.0","context_length":1048576,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"xai/grok-4.5","context_length":500000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"xai/grok-4.6","context_length":500000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"xai/grok-4.7","context_length":500000,"supported_endpoints":["/chat/completions","/responses"]},
  {"id":"mistral/mistral-large-4","context_length":524288,"supported_endpoints":["/chat/completions","/responses"]}
];

export function commandModelEntries(payload) {
  if (!Array.isArray(payload?.data) || !payload.data.length || payload.data.length > 500)
    throw new Error('command_catalog_invalid');
  const ids = new Set();
  return payload.data.map(model => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/.test(model?.id ?? '') || ids.has(model.id)
        || !Number.isSafeInteger(model.context_length) || model.context_length < 1024 || model.context_length > 10000000
        || !Array.isArray(model.supported_endpoints) || !model.supported_endpoints.every(e => typeof e === 'string'))
      throw new Error('command_catalog_invalid');
    ids.add(model.id);
    return { id: model.id, context_length: model.context_length, supported_endpoints: [...model.supported_endpoints] };
  }).filter(model => model.supported_endpoints.includes('/chat/completions'));
}

export function commonCatalog(catalog, entries = COMMAND_MODEL_SEED) {
  const byIdentity = new Map();
  for (const entry of (entries.length ? commandModelEntries({ data: entries }) : [])) {
    const identity = commandIdentity(entry.id);
    // Ambiguous identities are excluded, rather than choosing an arbitrary supplier ID.
    byIdentity.set(identity, byIdentity.has(identity) ? null : entry);
  }
  const shared = [];
  for (const model of catalog.models) {
    if (model.router_provider !== 'opencode') continue;
    const id = model.router_model;
    const target = byIdentity.get(commandIdentity(id));
    if (!target) continue;
    const context = Math.min(model.context_window ?? 128000, target.context_length);
    shared.push({ ...model, slug: 'shared/' + id,
      display_name: (model.display_name ?? id).replace(/^OpenCode · /, ''),
      description: '選択した同じモデルを利用可能な経路へ自動切替します。',
      context_window: context, max_context_window: context,
      auto_compact_token_limit: Math.min(model.auto_compact_token_limit ?? 500000, Math.floor(context * 0.8)),
      input_modalities: ['text'], supports_image_detail_original: false,
      router_transport: 'chat', router_common_model: target.id });
  }
  return { models: [...catalog.models.filter(model => model.router_provider === 'openai'), ...shared] };
}

export function publicCommonCatalog(catalog) {
  return { models: catalog.models.map(({ router_provider, router_model, router_transport, router_common_model, ...model }) => model) };
}
