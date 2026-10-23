import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function waiting(name, result) {
  if (/(^|\.)(wait|write_stdin|sleep)$/.test(name)) return true;
  const text = typeof result === 'string' ? result : (JSON.stringify(result) ?? '');
  return /Process running with session ID|Script running with cell ID/.test(text)
    || /^(pending|running|queued|in_progress)$/i.test(text.trim())
    || /["']status["']\s*:\s*["'](?:pending|running|queued|in_progress)["']/i.test(text);
}
export function toolRecoveryPlan(input, { maxRounds = 64, repeatedResults = 3 } = {}) {
  if (!Array.isArray(input)) return null;
  const boundary = input.findLastIndex(item => item.role === 'user');
  if (boundary < 0) return null;
  const pending = new Map();
  let batch = [], signatures = [], last, repeats = 0, rounds = 0;
  for (const item of input.slice(boundary + 1)) {
    if (['function_call', 'custom_tool_call'].includes(item.type)) {
      if (!item.call_id || pending.has(item.call_id)) return null;
      let args = item.type === 'custom_tool_call' ? item.input : item.arguments;
      if (item.type === 'function_call') { try { args = canonical(JSON.parse(args)); } catch {} }
      pending.set(item.call_id, { name: item.name ?? '', signature: hash([item.type,item.name,args]) });
    } else if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      const call = pending.get(item.call_id);
      if (!call) return null;
      pending.delete(item.call_id);
      batch.push(waiting(call.name, item.output));
      signatures.push(hash([call.signature,item.output]));
      if (!pending.size) {
        rounds++;
        const signature = signatures.sort().join(':');
        repeats = !batch.some(Boolean) ? (signature === last ? repeats + 1 : 1) : 0;
        last = signature;
        batch = []; signatures = [];
      }
    } else if (item.type === 'compaction') return null;
  }
  if (pending.size) return null;
  if (repeats >= repeatedResults) return { reason: 'repeated_completed_result', rounds, repeats };
  if (rounds >= maxRounds) return { reason: 'turn_tool_budget', rounds, repeats };
  return null;
}
export function recoverWithAnswer(body) {
  return { ...body, tools: [], tool_choice: 'none', max_output_tokens: Math.min(body.max_output_tokens ?? 1024, 1024),
    input: [...body.input, { type: 'message', role: 'developer', content:
      'Tool execution is paused for this turn. Use the tool results already in this conversation to answer the latest user request now. '
      + 'Do not call or simulate more tools. State completed work, remaining work and uncertainty honestly. If observation is still pending, report that status. '
      + 'Do not repeat promises to check. Never claim an unfinished task succeeded. Reply in the user\'s language.' }] };
}
// Recovery gets one answer request. Even a provider ignoring tools=[]/none cannot
// dispatch a tool. Buffer only this exceptional response until validation.
export function answerOnlyStream(contentType, maxBytes) {
  let bytes = 0, chunks = [];
  const failure = { type: 'response.failed', response: { id: 'resp_recovery_failed', object: 'response', status: 'failed', output: [],
    error: { code: 'invalid_prompt', message: '回答への復帰中に不正な応答を受けたため停止しました。履歴は保持しています。' } } };
  const isSse = contentType.includes('text/event-stream');
  const invalidTool = value => value?.item && ['function_call','custom_tool_call'].includes(value.item.type)
    || (value?.output ?? value?.response?.output ?? []).some(item => ['function_call','custom_tool_call'].includes(item.type));
  return new Transform({
    transform(chunk, _encoding, callback) { bytes += chunk.length; if (bytes <= maxBytes) chunks.push(chunk); callback(); },
    flush(callback) {
      let text = Buffer.concat(chunks).toString('utf8');
      try {
        if (bytes > maxBytes) throw new Error('size');
        const frames = isSse ? text.split(/\r?\n\r?\n/).map(frame => frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n'))
          .filter(data=>data && data !== '[DONE]').map(data=>JSON.parse(data)) : [JSON.parse(text)];
        if (frames.some(invalidTool)) throw new Error('tool');
        if (isSse && !frames.some(frame=>['response.completed','response.failed','response.incomplete'].includes(frame.type))) throw new Error('terminal');
        if (!isSse && !['completed','failed','incomplete'].includes(frames[0].status)) throw new Error('terminal');
      } catch {
        text = isSse ? `event: response.failed\ndata: ${JSON.stringify(failure)}\n\n` : JSON.stringify(failure.response);
      }
      chunks = []; this.push(text); callback();
    },
  });
}
