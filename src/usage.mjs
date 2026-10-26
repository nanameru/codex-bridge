// Usage is telemetry, never a reason to fail a valid answer or execute a tool.
// Whitelist validated fields: provider metadata and arbitrary response text must
// not enter the canonical usage object. Unknown counts remain absent, not zero.
const count = value => Number.isSafeInteger(value) && value >= 0;

export function chatUsageToResponses(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const input = usage.prompt_tokens, output = usage.completion_tokens;
  if (!count(input) || !count(output) || !count(input + output)) return undefined;
  const total = usage.total_tokens === undefined ? input + output : usage.total_tokens;
  if (!count(total) || total !== input + output) return undefined;
  const result = { input_tokens: input, output_tokens: output, total_tokens: total };

  const aliases = [usage.prompt_tokens_details?.cached_tokens, usage.prompt_cache_hit_tokens]
    .filter(value => value !== undefined && value !== null);
  const cached = aliases[0];
  const miss = usage.prompt_cache_miss_tokens;
  if (aliases.length && aliases.every(value => count(value) && value === cached)
      && cached <= input && (miss === undefined || miss === null
        || (count(miss) && cached + miss === input))) {
    result.input_tokens_details = { cached_tokens: cached };
  }
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (count(reasoning) && reasoning <= output) result.output_tokens_details = { reasoning_tokens: reasoning };
  return result;
}
