/** Explicitly enabled, fail-closed eligibility for the published free window. */
export const WHATSTOKEN = Object.freeze({ label: 'WhatsToken（無料時間のみ）',
  base: 'https://www.whatstoken.ai/v1', model: 'deepseek-v4.1-flash-1017',
  environment: 'WHATSTOKEN_API_KEY', keyFile: 'whatstoken-api-key', context: 1000000, vision: true });
export const WHATSTOKEN_POLICY = Object.freeze({
  models: 'https://www.whatstoken.ai/api/v1/marketplace/public',
  settings: 'https://www.whatstoken.ai/api/v1/settings',
});
const MAX_BYTES = 1024 * 1024;
const SAFETY_MS = 5000;
const LOCAL_OFFSET_MS = 8 * 3600000;

// Reserve a full router deadline before the end, plus a small clock margin.
export function freeWindow(now, reserveMs = 300000) {
  if (!Number.isSafeInteger(now) || !Number.isFinite(reserveMs) || reserveMs < 0) return null;
  const local = new Date(now + LOCAL_OFFSET_MS);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (minute >= 480 && minute < 1320) return null;
  const end = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + (minute >= 1320 ? 1 : 0), 8) - LOCAL_OFFSET_MS;
  return end - now > reserveMs + SAFETY_MS ? { end } : null;
}

function parseJSON(text, fallback) {
  if (typeof text !== 'string') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}
function minutes(text) {
  return typeof text === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(text)
    ? Number(text.slice(0, 2)) * 60 + Number(text.slice(3)) : null;
}
function inSlot(slot, now) {
  const local = new Date(now + LOCAL_OFFSET_MS);
  const day = local.getUTCDay() || 7;
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const start = minutes(slot.start), end = minutes(slot.end);
  if (!Array.isArray(slot.days) || !slot.days.includes(day) || start === null || end === null || start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function publishedFree(models, settings, now) {
  if (settings?.site?.default_timezone !== 'Asia/Singapore'
      || settings?.site?.admin_display_timezone !== 'Asia/Singapore') return false;
  if (!Array.isArray(models?.models)) return false;
  const matches = models.models.filter(model => model.model_id === WHATSTOKEN.model);
  if (matches.length !== 1) return false;
  const model = matches[0], billing = model.billing;
  if (model.has_ha !== false || billing?.billing_type !== 'tokens' || billing?.billing_rule !== 'standard') return false;
  if (parseJSON(model.discount_schedule, {})?.enabled !== false) return false;
  if (JSON.stringify(parseJSON(billing.pricing_tiers, null)) !== '[]') return false;
  if (!['fixed_rate', 'duration_rate', 'claude_cache_creation_rate', 'claude_cache_read_rate']
    .every(name => billing[name] === 0)) return false;
  if (![billing.prompt_rate, billing.completion_rate, billing.cached_rate].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return false;
  const config = parseJSON(billing.extended_config, null);
  if (!config || config.enable_time_multipliers !== true || config.time_input_tz !== 'operation'
      || config.invert_time_multipliers !== true || config.invert_remainder_multiplier !== 1
      || config.web_search_rate !== 0 || !Array.isArray(config.time_multipliers)) return false;
  const known = new Set(['enable_time_multipliers', 'invert_time_multipliers', 'invert_remainder_multiplier',
    'time_input_tz', 'time_multipliers', 'web_search_rate', 'supported_models']);
  if (Object.keys(config).some(name => !known.has(name))) return false;
  const slots = config.time_multipliers;
  if (slots.some(slot => !slot || !Array.isArray(slot.days) || !slot.days.length
      || slot.days.some(day => !Number.isInteger(day) || day < 1 || day > 7)
      || minutes(slot.start) === null || minutes(slot.end) === null || slot.start === slot.end
      || typeof slot.multiplier !== 'number' || !Number.isFinite(slot.multiplier) || slot.multiplier < 0)) return false;
  const free = slots.filter(slot => slot.multiplier === 0);
  if (free.length !== 2 || !free.some(slot => slot.start === '00:00' && slot.end === '08:00')
      || !free.some(slot => slot.start === '22:00' && slot.end === '00:00')
      || free.some(slot => new Set(slot.days).size !== 7)) return false;
  // Reject new paid slots that could start inside the expected free window
  // while an already-started request is still running.
  if (slots.some(slot => slot.multiplier > 0 && (minutes(slot.start) < 480
      || minutes(slot.end) > 1320 || minutes(slot.start) >= minutes(slot.end)))) return false;
  const current = slots.filter(slot => inSlot(slot, now));
  return current.length > 0 && current.every(slot => slot.multiplier === 0);
}

async function publicJSON(fetcher, url, signal, now) {
  const response = await fetcher(url, { redirect: 'manual', signal,
    headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
  if (!response.ok || response.status !== 200 || !response.body) {
    response.body?.cancel().catch(() => {}); throw new Error('free_policy_unavailable');
  }
  const date = Date.parse(response.headers.get('date'));
  // Detect local clock skew; this is not independent proof of provider policy.
  // The fixed HTTPS origin is the trust boundary for the public pricing data.
  if (!Number.isFinite(date) || Math.abs(date - now) > 120000) {
    response.body.cancel().catch(() => {}); throw new Error('free_policy_clock_unverified');
  }
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('free_policy_too_large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.cancel().catch(() => {}); }
}

export class WhatstokenFreeGate {
  constructor({ fetcher = fetch, now = () => Date.now(), reserveMs = 300000 } = {}) {
    this.fetcher = fetcher; this.now = now; this.reserveMs = reserveMs; this.cooldownUntil = 0;
  }
  unavailable() { this.cooldownUntil = this.now() + 60000; this.cache = undefined; }
  async check(signal) {
    const now = this.now(), window = freeWindow(now, this.reserveMs);
    if (!window) return { allowed: false, reason: 'outside_free_window' };
    if (this.cooldownUntil > now) return { allowed: false, reason: 'provider_cooldown' };
    if (this.cache && now >= this.cache.at && now - this.cache.at < 5000 && this.cache.end === window.end)
      return { allowed: true, end: window.end };
    try {
      const deadline = AbortSignal.timeout(2000);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const [models, settings] = await Promise.all([
        publicJSON(this.fetcher, WHATSTOKEN_POLICY.models, combined, now),
        publicJSON(this.fetcher, WHATSTOKEN_POLICY.settings, combined, now),
      ]);
      if (!publishedFree(models, settings, this.now()) || !freeWindow(this.now(), this.reserveMs))
        return { allowed: false, reason: 'free_price_unverified' };
      this.cache = { at: this.now(), end: window.end };
      return { allowed: true, end: window.end };
    } catch {
      this.cache = undefined;
      if (signal?.aborted) signal.throwIfAborted();
      return { allowed: false, reason: 'free_policy_unavailable' };
    }
  }
}
