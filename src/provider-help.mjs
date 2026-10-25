import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';

export const PROVIDER_HELP = Object.freeze({
  opencode: Object.freeze({ label: 'OpenCode Go', login: 'https://opencode.ai/console/', billing: 'https://opencode.ai/console/go' }),
  commandcode: Object.freeze({ label: 'Command Code', login: 'https://commandcode.ai/signin', billing: 'https://commandcode.ai/billing' }),
  ollama: Object.freeze({ label: 'Ollama Cloud', login: 'https://ollama.com/signin', billing: 'https://ollama.com/pricing' }),
  whatstoken: Object.freeze({ label: 'WhatsToken', login: 'https://www.whatstoken.ai/login', billing: 'https://www.whatstoken.ai' }),
});
export function providerHelp(provider) {
  const help = Object.hasOwn(PROVIDER_HELP, provider) ? PROVIDER_HELP[provider] : null;
  return help ? `\n${help.label}：ログイン ${help.login} ／ プラン・支払い ${help.billing}` : '';
}
export function allProviderHelp() { return Object.keys(PROVIDER_HELP).map(providerHelp).join(''); }

// These are bridge commentary, not model text. The existing handoff filter
// removes this prefix from future inference requests and compaction summaries.
export function providerNoticeStream(contentType, maxBytes, messages) {
  const items = [...new Set(messages)].map(text => ({ id: 'msg_bridge_handoff_provider_' + randomUUID(),
    type: 'message', role: 'assistant', phase: 'commentary', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] }));
  let buffer = '', sequence = 0, emitted = false;
  const decoder = new TextDecoder();
  const sse = contentType.includes('text/event-stream');
  const frame = payload => `event: ${payload.type}\ndata: ${JSON.stringify({ ...payload, sequence_number: sequence++ })}\n\n`;
  const notices = () => {
    if (emitted) return ''; emitted = true;
    return items.map((item, index) => frame({ type: 'response.output_item.added', output_index: index,
      item: { ...item, status: 'in_progress', content: [] } })
      + frame({ type: 'response.content_part.added', output_index: index, content_index: 0, item_id: item.id,
        part: { type: 'output_text', text: '', annotations: [] } })
      + frame({ type: 'response.output_text.delta', output_index: index, content_index: 0, item_id: item.id, delta: item.content[0].text })
      + frame({ type: 'response.output_text.done', output_index: index, content_index: 0, item_id: item.id, text: item.content[0].text })
      + frame({ type: 'response.content_part.done', output_index: index, content_index: 0, item_id: item.id, part: item.content[0] })
      + frame({ type: 'response.output_item.done', output_index: index, item })).join('');
  };
  const convert = data => {
    const payload = JSON.parse(data);
    if (payload.type === 'response.created') return frame(payload) + notices();
    const prefix = notices();
    if (Number.isInteger(payload.output_index)) payload.output_index += items.length;
    if (Array.isArray(payload.response?.output)) payload.response.output = [...items, ...payload.response.output];
    return prefix + frame(payload);
  };
  const parse = text => {
    const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
    return data && data !== '[DONE]' ? convert(data) : '';
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        buffer += decoder.decode(chunk, { stream: true });
        if (sse) {
          let boundary;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const event = buffer.slice(0, boundary.index);
            if (Buffer.byteLength(event) > maxBytes) throw new Error('provider_notice_too_large');
            this.push(parse(event)); buffer = buffer.slice(boundary.index + boundary[0].length);
          }
        }
        if (Buffer.byteLength(buffer) > maxBytes) throw new Error('provider_notice_too_large');
        callback();
      } catch (error) { callback(error); }
    },
    flush(callback) {
      try {
        buffer += decoder.decode();
        if (Buffer.byteLength(buffer) > maxBytes) throw new Error('provider_notice_too_large');
        if (buffer.trim()) {
          if (sse) this.push(parse(buffer));
          else {
            const payload = JSON.parse(buffer);
            if (Array.isArray(payload.output)) payload.output = [...items, ...payload.output];
            this.push(JSON.stringify(payload));
          }
        }
        callback();
      } catch (error) { callback(error); }
    },
  });
}
