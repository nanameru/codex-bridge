// Opt-in live compatibility check. Synthetic data only; tools are never executed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readPrivateFile, codexRoot } from '../src/local-security.mjs';
if (process.env.RUN_LIVE_MODELS !== '1') { console.log('Skipped: set RUN_LIVE_MODELS=1 explicitly.'); process.exit(0); }
const models = process.argv.slice(2);
assert.ok(models.length >= 1 && models.length <= 3, 'specify 1–3 catalog model IDs');
assert.ok(models.every(model => /^opencode\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)), 'invalid model ID');
const auth = JSON.parse(readPrivateFile(codexRoot(), 'auth.json'));
const token = auth.tokens?.access_token ?? auth.OPENAI_API_KEY;
assert.ok(token, 'owner authentication unavailable');
const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json',
  ...(auth.tokens?.account_id ? { 'chatgpt-account-id': auth.tokens.account_id } : {}) };
const tool = { type: 'function', name: 'route_probe', description: 'Read synthetic build status once.',
  parameters: { type: 'object', properties: {}, additionalProperties: false } };
const user = { role: 'user', content: 'ビルド状況を一度確認して、結果を日本語で教えてください。' };
const output = call_id => ({ type: 'function_call_output', call_id, output: '{"status":"done","result":"BUILD_OK_42"}' });
let requests = 0, failures = 0;
async function ask(model, input, thread) {
  assert.ok(++requests <= models.length * 3, 'live request budget exceeded');
  const res = await fetch('http://127.0.0.1:8790/v1/responses', { method: 'POST', redirect: 'error',
    signal: AbortSignal.timeout(60000), headers, body: JSON.stringify({ model, input, tools: [tool], stream: true,
      max_output_tokens: 2048, reasoning: { effort: 'low' }, prompt_cache_key: thread,
      instructions: 'Call route_probe exactly once to obtain the build status. After its completed result, answer with BUILD_OK_42 and never call tools again.' }) });
  assert.equal(res.status, 200, 'upstream HTTP status ' + res.status);
  const reader = res.body.getReader(); let size = 0, text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; assert.ok(size <= 512000, 'live response too large');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
  const frames = text.split(/\r?\n\r?\n/).map(frame => frame.split(/\r?\n/).filter(l => l.startsWith('data:'))
    .map(l => l.slice(5).trimStart()).join('\n')).filter(v => v && v !== '[DONE]').map(JSON.parse);
  const result = frames.findLast(frame => ['response.completed', 'response.failed'].includes(frame.type))?.response;
  assert.equal(result?.status, 'completed', result?.error?.code ?? 'missing terminal');
  return result.output;
}
function assertAnswer(items) {
  assert.ok(!items.some(item => ['function_call', 'custom_tool_call'].includes(item.type)), 'unexpected repeated tool');
  assert.ok(items.some(item => item.type === 'message' && item.content?.some(part => part.text?.includes('BUILD_OK_42'))), 'missing build result');
}
for (const model of models) {
  const started = Date.now();
  try {
    const thread = 'bridge-smoke-' + randomUUID();
    const first = await ask(model, [user], thread);
    const calls = first.filter(item => item.type === 'function_call');
    assert.equal(calls.length, 1, 'expected exactly one probe'); assert.equal(calls[0].name, 'route_probe');
    assertAnswer(await ask(model, [user, ...first, output(calls[0].call_id)], thread));
    const repeated = [user, ...Array.from({ length: 3 }, (_, i) => [{ type: 'function_call', call_id: 'probe_' + i,
      name: 'route_probe', arguments: '{}' }, output('probe_' + i)]).flat()];
    assertAnswer(await ask(model, repeated, 'bridge-smoke-' + randomUUID()));
    console.log(JSON.stringify({ model, passed: true, scenarios: ['tool_once_then_answer', 'repeated_results_to_answer'], elapsed_ms: Date.now() - started }));
  } catch (error) {
    failures++;
    console.log(JSON.stringify({ model, passed: false, check: error.code ?? error.name, elapsed_ms: Date.now() - started }));
  }
}
console.log(JSON.stringify({ requests, failures }));
process.exitCode = failures ? 1 : 0;
