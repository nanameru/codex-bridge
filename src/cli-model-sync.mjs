import { join } from 'node:path';
import { CliControl } from './cli-control.mjs';
import { autoManualSlug } from './manual-providers.mjs';

export const CLI_AUTO_MODEL = 'opencode/deepseek-v4.1-flash';
export const cliProviderModel = provider => provider === 'opencode' ? CLI_AUTO_MODEL : autoManualSlug(provider);
const MODELS = new Set([CLI_AUTO_MODEL, autoManualSlug('commandcode'), autoManualSlug('ollama')]);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function cliThreadId(body, headers = {}) {
  for (const value of [body.client_metadata?.thread_id, body.prompt_cache_key, headers.session_id]) {
    if (typeof value === 'string' && UUID.test(value)) return value.toLowerCase();
  }
  return null;
}

// Automatic intent lives in the selected catalog ID, not a separate thread DB.
// The existing two manual IDs always remain fixed, including after ABA changes.
export class CliModelSync {
  constructor({ root, socketPath = join(root, 'app-server-control/app-server-control.sock'), control,
    routerBase = 'http://127.0.0.1:8790/v1' } = {}) {
    this.control = control ?? new CliControl({ socketPath });
    this.routerBase = routerBase;
    this.providers = new Set(); this.providerCacheUntil = 0;
  }
  #isRouterProvider(provider) {
    if (provider?.requires_openai_auth !== true) return false;
    try {
      const expected = new URL(this.routerBase), target = new URL(provider.base_url);
      return [expected, target].every(url => url.protocol === 'http:' && LOOPBACK.has(url.hostname)
        && !url.username && !url.password && !url.search && !url.hash)
        && (target.port || '80') === (expected.port || '80')
        && target.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '');
    } catch { return false; }
  }
  async #allowsProvider(name) {
    if (name === 'openai') return true; // Preserve the original native integration.
    if (this.providerEpoch === (this.control.epoch ?? 0) && performance.now() < this.providerCacheUntil)
      return this.providers.has(name);
    if (!this.loadingProviders) this.loadingProviders = (async () => {
      const result = await this.control.request('config/read', { includeLayers: false });
      const providers = new Set();
      for (const [id, config] of Object.entries(result?.config?.model_providers ?? {}))
        if (this.#isRouterProvider(config)) providers.add(id);
      // Keep only names and validation results, never the configuration/secrets.
      this.providers = providers; this.providerEpoch = this.control.epoch ?? 0;
      this.providerCacheUntil = performance.now() + 30000;
    })();
    const loading = this.loadingProviders;
    try { await loading; } finally { if (this.loadingProviders === loading) this.loadingProviders = null; }
    return this.providers.has(name);
  }
  async #read(id) {
    const result = await this.control.request('thread/read', { threadId: id, includeTurns: false });
    const thread = result?.thread;
    if (thread?.id !== id || typeof thread.model !== 'string'
        || thread.status?.type === 'notLoaded') throw new Error('thread_not_available');
    if (!await this.#allowsProvider(thread.modelProvider)) throw new Error('thread_provider_unavailable');
    return thread;
  }
  async prepare(id, requestedModel, diagnose = () => {}) {
    if (!MODELS.has(requestedModel)) return null;
    if (!id || !UUID.test(id)) { diagnose('thread_id_unavailable'); return null; }
    try {
      const thread = await this.#read(id);
      if (!MODELS.has(thread.model)) { diagnose('manual_selection'); return null; }
      return { id, model: thread.model, automatic: true };
    } catch (error) {
      const safe = new Set(['thread_not_available', 'thread_provider_unavailable',
        'control_unavailable', 'control_timeout', 'control_rpc_failed']);
      diagnose(safe.has(error?.message) ? error.message : 'sync_unavailable');
      return null;
    }
  }
  async sync(context, target) {
    if (!context || !MODELS.has(target)) return 'unavailable';
    if (target === context.model) return 'unchanged';
    try {
      const thread = await this.#read(context.id);
      if (thread.model !== context.model) return 'manual';
      await this.control.request('thread/settings/update', { threadId: context.id, model: target });
      const deadline = performance.now() + 1000;
      while (performance.now() < deadline) {
        let timer;
        let after;
        try {
          // This is a read-only RPC: a late reply is harmless, but it must not
          // delay inference beyond the overall confirmation deadline.
          after = await Promise.race([this.#read(context.id), new Promise(resolve => {
            timer = setTimeout(() => resolve(null), Math.max(1, deadline - performance.now()));
          })]);
        } finally { clearTimeout(timer); }
        if (!after) return 'unavailable';
        if (after.model === target) { context.model = target; return 'updated'; }
        if (after.model !== context.model) return 'manual';
        await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(0, deadline - performance.now()))));
      }
      return 'unavailable';
    } catch { return 'unavailable'; }
  }
  close() { this.control.close?.(); }
}
