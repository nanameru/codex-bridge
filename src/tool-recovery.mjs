import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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
  return { ...body, tools: [], tool_choice: 'none', max_output_tokens: Math.min(body.max_output_tokens ?? 8192, 8192),
    input: [...body.input, { type: 'message', role: 'developer', content:
      'Tool execution is paused for this turn. Use the tool results already in this conversation to answer the latest user request now. '
      + 'Do not call or simulate more tools. State completed work, remaining work and uncertainty honestly. If observation is still pending, report that status. '
      + 'Keep the report concise, around 1500 characters. Do not repeat promises to check. Never claim an unfinished task succeeded. Reply in the user\'s language.' }] };
}
// Recovery allows one bounded retry for length or empty output. A provider ignoring tools=[]/none cannot
// dispatch a tool. Buffer only this exceptional response until validation.
export function answerOnlyStream(contentType, maxBytes, { retry, diagnose = () => {} } = {}) {
  let bytes = 0, chunks = [];
  const failure = { type: 'response.failed', response: { id: 'resp_recovery_' + randomUUID(), object: 'response', status: 'failed', output: [],
    error: { code: 'invalid_prompt', message: '回答への復帰中に不正な応答を受けたため停止しました。履歴は保持しています。' } } };
  const isSse = contentType.includes('text/event-stream');
  const safeItem = item => item && ['message','reasoning'].includes(item.type);
  const hasAnswer = output => Array.isArray(output) && output.some(item => item.type === 'message'
    && [undefined,'assistant'].includes(item.role) && Array.isArray(item.content)
    && item.content.some(part => (part.type === 'output_text' && typeof part.text === 'string' && part.text.trim())
      || (part.type === 'refusal' && typeof part.refusal === 'string' && part.refusal.trim())));
  const safeEvent = type => ['response.created','response.in_progress','response.queued','response.completed','response.failed','response.incomplete',
    'response.output_item.added','response.output_item.done','response.content_part.added','response.content_part.done'].includes(type)
    || /^response\.(output_text|refusal|reasoning_[a-z_]+)\./.test(type);
  const validPayload = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.item && !safeItem(value.item)) return false;
    const output = value.output ?? value.response?.output;
    return output === undefined || (Array.isArray(output) && output.every(safeItem));
  };
  return new Transform({
    transform(chunk, _encoding, callback) { bytes += chunk.length; if (bytes <= maxBytes) chunks.push(chunk); callback(); },
    flush(callback) {
      const run = async () => {
      let text = '';
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        if (bytes > maxBytes) throw new Error('size');
        const frames = isSse ? text.split(/\r?\n\r?\n/).map(frame => frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n'))
          .filter(data=>data && data !== '[DONE]').map(data=>JSON.parse(data)) : [JSON.parse(text)];
        if (!frames.length || !frames.every(validPayload)) throw new Error('tool');
        let result;
        if (isSse) {
          if (!frames.every(frame => safeEvent(frame.type))) throw new Error('event');
          const terminals = frames.filter(frame => ['response.completed','response.failed','response.incomplete'].includes(frame.type));
          if (terminals.length !== 1 || frames.at(-1) !== terminals[0]) throw new Error('terminal');
          result = terminals[0].response;
          if (result?.status !== terminals[0].type.slice('response.'.length)) throw new Error('status');
        } else result = frames[0];
        if (!result || !['completed','failed','incomplete'].includes(result.status)) throw new Error('terminal');
        const empty = result.error?.reason === 'empty_output' || (result.status === 'completed' && !hasAnswer(result.output));
        const length = !empty && (result.error?.reason === 'max_output_tokens' || result.incomplete_details?.reason === 'max_output_tokens');
        diagnose({ recovery_response_status: empty ? 'failed' : result.status, ...(length ? { recovery_finish_reason: 'length' } : empty ? { recovery_finish_reason: 'empty_output' } : {}) });
        if ((length || empty) && retry) {
          const upstream = await retry(length ? 'length' : 'empty_output');
          if (!upstream) { if (empty && result.status === 'completed') throw new Error('empty answer'); return text; }
          if (!upstream.ok || !upstream.body) { await upstream.body?.cancel(); throw new Error('retry upstream'); }
          const retryType = upstream.headers.get('content-type') ?? 'application/json';
          if (retryType.includes('text/event-stream') !== isSse) { await upstream.body.cancel(); throw new Error('retry format'); }
          const recovered = [];
          // Same validation, no retry callback: at most one extra generation.
          await pipeline(Readable.fromWeb(upstream.body), answerOnlyStream(retryType, maxBytes, { diagnose }),
            new Writable({ write(chunk, _encoding, done) { recovered.push(chunk); done(); } }));
          text = Buffer.concat(recovered).toString('utf8');
        } else if (empty && result.status === 'completed') throw new Error('empty answer');
      } catch {
        diagnose({ recovery_response_status: 'failed' });
        text = isSse ? `event: response.failed\ndata: ${JSON.stringify(failure)}\n\n` : JSON.stringify(failure.response);
      }
      chunks = []; return text;
      };
      run().then(text => { this.push(text); callback(); }, callback);
    },
  });
}
