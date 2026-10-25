import { join } from 'node:path';
import { CliControl } from './cli-control.mjs';
import { autoManualSlug } from './manual-providers.mjs';

export const CLI_AUTO_MODEL = 'opencode/deepseek-v4.1-flash';
export const cliProviderModel = provider => provider === 'opencode' ? CLI_AUTO_MODEL : autoManualSlug(provider);
const MODELS = new Set([CLI_AUTO_MODEL, autoManualSlug('commandcode'), autoManualSlug('ollama')]);
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
  constructor({ root, socketPath = join(root, 'app-server-control/app-server-control.sock'), control } = {}) {
    this.control = control ?? new CliControl({ socketPath });
  }
  async #read(id) {
    const result = await this.control.request('thread/read', { threadId: id, includeTurns: false });
    const thread = result?.thread;
    if (thread?.id !== id || thread.modelProvider !== 'openai' || typeof thread.model !== 'string'
        || thread.status?.type === 'notLoaded') throw new Error('thread_not_available');
    return thread;
  }
  async prepare(id, requestedModel) {
    if (!id || !UUID.test(id) || !MODELS.has(requestedModel)) return null;
    try {
      const thread = await this.#read(id);
      return MODELS.has(thread.model) ? { id, model: thread.model, automatic: true } : null;
    } catch { return null; }
  }
  async sync(context, target) {
    if (!context || !MODELS.has(target)) return 'unavailable';
    if (target === context.model) return 'unchanged';
    try {
      const thread = await this.#read(context.id);
      if (thread.model !== context.model) return 'manual';
      await this.control.request('thread/settings/update', { threadId: context.id, model: target });
      const deadline = Date.now() + 1000;
      for (;;) {
        const after = await this.#read(context.id);
        if (after.model === target) { context.model = target; return 'updated'; }
        if (after.model !== context.model) return 'manual';
        if (Date.now() >= deadline) return 'unavailable';
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } catch { return 'unavailable'; }
  }
  close() { this.control.close?.(); }
}
