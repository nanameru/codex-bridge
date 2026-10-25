/** Explicit, owner-selected DeepSeek endpoints. No provider fallback. */
import { PassThrough, Readable } from 'node:stream';
import { readPrivateFile, codexRoot } from './local-security.mjs';
import { buildCatalog } from './make-catalog.mjs';
import { chatMessages, chatToResponses, pipeChatStream } from './chat-protocol.mjs';
import { readUpstreamFailure } from './handoff-status.mjs';
import { reasoningOptions } from './upstream-options.mjs';
import { providerHelp } from './provider-help.mjs';
import { classifyProviderLimit } from './provider-fallback.mjs';

export const MANUAL_PROVIDERS = Object.freeze({
  commandcode: Object.freeze({ label: 'Command Code', base: 'https://api.commandcode.ai/provider/v1',
    model: 'deepseek/deepseek-v4.1-flash', environment: 'CMD_API_KEY', keyFile: 'commandcode-api-key', context: 1000000, vision: false }),
  ollama: Object.freeze({ label: 'Ollama Cloud', base: 'https://ollama.com/v1',
    model: 'deepseek-v4.1-flash', environment: 'OLLAMA_API_KEY', keyFile: 'ollama-api-key', context: 1048576, vision: true }),
});
export const manualSlug = provider => provider + '/deepseek-v4.1-flash';
export const autoManualSlug = provider => 'auto-' + manualSlug(provider);
export function readManualKey(provider, root = codexRoot(), environment = process.env) {
  const config = MANUAL_PROVIDERS[provider];
  if (!config) return null;
  const value = environment[config.environment] ?? readPrivateFile(root, config.keyFile)?.trim();
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\s\x00-\x1f\x7f]/.test(value) ? value : null;
}
export function manualModels() {
  return Object.entries(MANUAL_PROVIDERS).map(([provider, config]) => {
    const model = buildCatalog([{ id: 'deepseek-v4.1-flash', name: `${config.label} · DeepSeek V4.1 Flash`,
      desc: `${config.label}の利用枠を使う手動切替。自動fallbackなし。`, ctx: config.context, out: 32768,
      compact: 500000, vision: config.vision, efforts: ['none','low','medium','high','xhigh','max'], tier: 'balanced' }]).models[0];
    return { ...model, slug: manualSlug(provider), router_provider: provider, router_model: config.model, router_transport: 'chat' };
  });
}
export function automaticModels() {
  return manualModels().map(model => ({ ...model, slug: autoManualSlug(model.router_provider),
    display_name: model.display_name + '（自動切替）',
    description: 'OpenCode → Command Code → Ollamaの優先順で利用枠に応じて自動切替・復帰します。' }));
}
export function withManualModels(catalog) {
  const external = new Set(Object.keys(MANUAL_PROVIDERS));
  return { ...catalog, models: [...catalog.models.filter(model => !external.has(model.router_provider)), ...manualModels(),
    ...automaticModels()] };
}

export function manualChatBody(provider, body) {
  const config = MANUAL_PROVIDERS[provider];
  if (!config || body.model !== config.model) throw new Error('manual_model_invalid');
  const result = { model: config.model, messages: chatMessages(body, body.reasoning?.effort !== 'none'), stream: body.stream === true };
  if (result.stream) result.stream_options = { include_usage: true };
  const tools = (body.tools ?? []).filter(tool => tool.type === 'function' || tool.function).map(tool => ({ type: 'function',
    function: tool.function ?? { name: tool.name, description: tool.description ?? '', parameters: tool.parameters ?? { type: 'object', properties: {} } } }));
  if (tools.length) result.tools = tools;
  if (body.tool_choice !== undefined) result.tool_choice = body.tool_choice;
  if (body.max_output_tokens !== undefined) result.max_tokens = body.max_output_tokens;
  for (const key of ['temperature','top_p','frequency_penalty','presence_penalty']) if (body[key] !== undefined) result[key] = body[key];
  if (provider === 'commandcode') Object.assign(result, reasoningOptions(config.model.split('/').at(-1), body.reasoning?.effort));
  else if (body.reasoning?.effort !== undefined) result.reasoning_effort = body.reasoning.effort;
  return result;
}

async function boundedJSON(response, maxBytes) {
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('manual_response_too_large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function fetchManualProvider(provider, url, options, fetcher, maxBytes, maxInputTokens) {
  const config = MANUAL_PROVIDERS[provider];
  if (!config || url !== config.base + '/responses') throw new Error('manual_destination_invalid');
  const body = JSON.parse(options.body);
  const chat = manualChatBody(provider, body);
  const serialized = JSON.stringify(chat);
  // The router checks Responses input before this final Chat wire check.
  // Neither representation is truncated to satisfy a budget.
  if (Buffer.byteLength(serialized) > maxBytes) return Response.json({ error: { type: 'request_too_large', message: 'Chat変換後の入力が送信上限を超えました。履歴は保持しています。' } }, { status: 413 });
  if (maxInputTokens && maxInputTokens(chat) === false) return Response.json({ error: { type: 'input_budget_exceeded', message: 'Chat変換後の入力がモデル上限を超えました。履歴は保持しています。' } }, { status: 413 });
  const upstream = await fetcher(config.base + '/chat/completions', { method: 'POST', redirect: 'manual', signal: options.signal,
    headers: { authorization: options.headers.authorization, 'content-type': 'application/json', accept: 'text/event-stream, application/json' }, body: serialized });
  if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); return new Response(null, { status: upstream.status }); }
  if (!upstream.ok) {
    const limit = await classifyProviderLimit(upstream);
    const detail = upstream.body ? await readUpstreamFailure(upstream) : { code: "unknown_error" };
    const retryAfter = upstream.headers.get('retry-after');
    return Response.json({ error: { type: 'provider_error', code: limit ? 'usage_exceeded' : detail.code,
      ...(limit ? { window: limit.window, ...(limit.resetKnown ? { resets_at: new Date(limit.resetAt).toISOString() } : {}), reset_known: limit.resetKnown } : {}),
      message: `${config.label}が要求を拒否しました（HTTP ${upstream.status}、${detail.code}）。利用枠と認証設定を確認してください。${limit || [401,403].includes(upstream.status) ? providerHelp(provider) : ''}` } },
    { status: upstream.status, headers: /^\d{1,6}$/.test(retryAfter ?? '') ? { 'retry-after': retryAfter } : {} });
  }
  if (!upstream.body) throw new Error('manual_empty_response');
  if (!body.stream) return Response.json(chatToResponses(await boundedJSON(upstream, maxBytes), body.model));
  if (!upstream.headers.get('content-type')?.includes('text/event-stream')) { await upstream.body.cancel(); throw new Error('manual_stream_required'); }
  const output = new PassThrough();
  output.writeHead = () => {};
  const web = Readable.toWeb(output);
  const abort = () => output.destroy();
  output.once('close', () => { options.signal?.removeEventListener('abort', abort); upstream.body.cancel().catch(() => {}); });
  options.signal?.addEventListener('abort', abort, { once: true });
  queueMicrotask(() => {
    if (options.signal?.aborted) { abort(); return; }
    pipeChatStream(upstream, output, body.model, undefined, { maxBytes }).catch(() => output.destroy());
  });
  return new Response(web, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
}
