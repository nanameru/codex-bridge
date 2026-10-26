/** Offline fixture: real Codex/MCP, scripted model behind the actual Chat bridge. */
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRouter } from '../src/model-router.mjs';
const calls = [];
function discoveredTools(result) {
  try {
    const parts = JSON.parse(result?.content ?? 'null');
    if (!Array.isArray(parts)) return [];
    for (const part of parts) {
      if (typeof part.text !== 'string') continue;
      try {
        const value = JSON.parse(part.text);
        if (Array.isArray(value.tools)) return value.tools;
      } catch { /* Non-JSON execution metadata. */ }
    }
  } catch { /* The test's strict search-result assertion will fail. */ }
  return [];
}
const bind = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const upstream = http.createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  const evolution = process.env.SYNTHETIC_HISTORY_EVOLUTION === '1';
  if (calls.length >= (evolution ? 6 : 3)) { res.writeHead(500); res.end('fixture request limit'); return; }
  const body = JSON.parse(text);
  const toolList = body.tools ?? [];
  const exec = toolList.find(t => t.function?.name === 'exec' || t.function?.description?.startsWith('Original tool: functions.exec\n'));
  const codeMode = process.env.SYNTHETIC_CODE_MODE === '1';
  const search = toolList.find(t => t.function?.name.startsWith('cxb_tool_search'));
  const target = toolList.find(t => t.function?.description?.includes('NEEDLE_TARGET_OK'));
  const toolResults = (body.messages ?? []).filter(m => m.role === 'tool');
  const phase = evolution ? Math.floor(calls.length / 3) : 0;
  const searchId = evolution ? 'call_search_' + phase : 'call_search';
  const targetId = evolution ? 'call_target_' + phase : 'call_target';
  const targetResult = toolResults.find(m => m.tool_call_id === targetId && typeof m.content === 'string' && m.content.includes('NEEDLE_TARGET_OK'));
  const step = calls.length % 3;
  const discoveries = discoveredTools(toolResults.find(m => m.tool_call_id === searchId));
  calls.push({ path: req.url, toolsCount: toolList.length, toolsBytes: Buffer.byteLength(JSON.stringify(toolList)),
    toolNames: toolList.map(t => t.function?.name ?? t.name ?? t.type),
    searchResultNames: codeMode && step === 1 ? discoveries.map(tool => tool.name) : undefined,
    searchResultSchemaV2: codeMode && step === 1 ? discoveries.some(tool => tool.description?.includes('SCHEMA_V2')) : undefined,
    targetSchemaV2: target?.function?.description?.includes('SCHEMA_V2') ?? false,
    hasSearch: Boolean(search), hasTarget: Boolean(target), toolResultCount: toolResults.length,
    includeUsage: body.stream_options?.include_usage === true });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = value => res.write('data: ' + JSON.stringify(value) + '\n\n');
  if (codeMode && exec && step < 2) {
    const input = step === 0 ? 'text(await tools.tool_search({query: "needle_target", limit: 1}));' : `text(await tools.mcp__synthetic__needle_target(${phase === 1 ? '{revision: 2}' : '{}'}));`;
    emit({choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:step===0?searchId:targetId,type:'function',function:{name:exec.function.name,arguments:JSON.stringify({input})}}]}}]});
    emit({choices:[{index:0,delta:{},finish_reason:'tool_calls'}]});
  } else if (step === 0 && search) {
    emit({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: searchId, type: 'function',
      function: { name: search.function.name, arguments: JSON.stringify({ query: 'needle_target', limit: 1 }) } }] } }] });
    emit({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else if (step === 1 && target) {
    emit({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: targetId, type: 'function',
      function: { name: target.function.name, arguments: JSON.stringify(phase === 1 ? {revision: 2} : {}) } }] } }] });
    emit({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    emit({ choices: [{ index: 0, delta: { role: 'assistant', content: targetResult ? 'NEEDLE_TARGET_OK' : 'FIXTURE_SEARCH_MISSING' } }] });
    emit({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  emit({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
    prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40, completion_tokens_details: { reasoning_tokens: 2 } } });
  res.end('data: [DONE]\n\n');
});
const upstreamPort = await bind(upstream);
const reservation = http.createServer();
const bridgePort = await bind(reservation);
await new Promise(resolve => reservation.close(resolve));
const bridge = spawn(process.execPath, [new URL('../src/codex-bridge.mjs', import.meta.url).pathname], {
  env: { ...process.env, HOME: process.env.CODEX_HOME, PORT: String(bridgePort), OPENCODE_API_KEY: 'synthetic-opencode-key',
    UPSTREAM_BASE: `http://127.0.0.1:${upstreamPort}/v1`, CODEX_BRIDGE_TEST_UPSTREAM: '1', LOG_LEVEL: 'info' },
  stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('fixture bridge startup timed out')), 5000);
  bridge.stdout.on('data', chunk => { if (chunk.toString().includes('codex-bridge listening')) { clearTimeout(timer); resolve(); } });
  bridge.once('exit', () => { clearTimeout(timer); reject(new Error('fixture bridge exited')); });
});
const catalog = JSON.parse(readFileSync(process.env.CODEX_HOME + '/catalog.json'));
const router = createRouter({ catalog, bridgeBase: `http://127.0.0.1:${bridgePort}/v1`,
  bridgeKey: () => 'a'.repeat(64), authenticate: request => request.headers.authorization === 'Bearer synthetic-key' });
const port = await bind(router);
process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${port}/v1` }) + '\n');
process.stdin.on('data', () => process.stdout.write(JSON.stringify({ calls }) + '\n'));
process.stdin.on('end', () => { for (const server of [upstream, router]) { server.closeAllConnections(); server.close(); } bridge.kill(); });
