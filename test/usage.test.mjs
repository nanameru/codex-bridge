import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { chatToResponses, pipeChatStream } from '../src/chat-protocol.mjs';
import { chatUsageToResponses } from '../src/usage.mjs';

const complete = usage => ({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
  ...(usage === undefined ? {} : { usage }) });
const expected = { input_tokens: 10, output_tokens: 5, total_tokens: 15,
  input_tokens_details: { cached_tokens: 7 }, output_tokens_details: { reasoning_tokens: 3 } };
const detailed = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
  prompt_cache_hit_tokens: 7, prompt_cache_miss_tokens: 3,
  prompt_tokens_details: { cached_tokens: 7 }, completion_tokens_details: { reasoning_tokens: 3 } };

async function streamed(usage) {
  const frames = [{ choices: [{ delta: { content: 'OK' }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] }, ...(usage === undefined ? [] : [{ choices: [], usage }])];
  const wire = frames.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n';
  const body = new ReadableStream({ start(controller) {
    // Split UTF8 and event boundaries so accounting cannot rely on full chunks.
    for (let i = 0; i < wire.length; i += 3) controller.enqueue(Buffer.from(wire.slice(i, i + 3)));
    controller.close();
  } });
  const response = new EventEmitter(); response.text = '';
  response.writeHead = () => {}; response.write = value => { response.text += value; };
  response.end = () => { response.writableEnded = true; };
  const recorded = [];
  await pipeChatStream({ body }, response, 'test', 'thread', { recordUsage: (...args) => recorded.push(args) });
  const events = response.text.split('\n\n').filter(value => value.startsWith('event:'))
    .map(value => JSON.parse(value.split('\ndata: ')[1]));
  return { result: events.at(-1).response, recorded };
}

test('Chat JSON and SSE preserve cached/reasoning counts without double counting totals', async () => {
  for (const usage of [detailed, { ...detailed, prompt_tokens_details: undefined },
    { ...detailed, prompt_cache_hit_tokens: undefined, prompt_cache_miss_tokens: undefined }]) {
    assert.deepEqual(chatToResponses(complete(usage), 'test').usage, expected);
    const { result, recorded } = await streamed(usage);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.usage, expected);
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0].slice(0, 4), ['thread', 'test', 10, 5]);
    assert.deepEqual(recorded[0][4], expected);
  }
});

test('explicit zero survives while absent or incomplete usage remains unknown', async () => {
  const zero = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0,
    completion_tokens_details: { reasoning_tokens: 0 } };
  const normalized = { input_tokens: 0, output_tokens: 0, total_tokens: 0,
    input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  assert.deepEqual(chatToResponses(complete(zero), 'test').usage, normalized);
  assert.deepEqual((await streamed(zero)).result.usage, normalized);
  for (const usage of [undefined, null, {}, { prompt_tokens: 10 }, { completion_tokens: 5 }]) {
    const json = chatToResponses(complete(usage), 'test');
    const { result, recorded } = await streamed(usage);
    assert.equal(json.status, 'completed'); assert.equal(result.status, 'completed');
    assert.equal(json.usage, undefined); assert.equal(result.usage, undefined);
    assert.equal(recorded.length, 0);
  }
});

test('missing total is derived from known input/output; supplied inconsistent or invalid totals are omitted', async () => {
  const missing = { prompt_tokens: 10, completion_tokens: 5 };
  const normalized = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
  assert.deepEqual(chatToResponses(complete(missing), 'test').usage, normalized);
  assert.deepEqual((await streamed(missing)).result.usage, normalized);
  for (const usage of [{ ...missing, total_tokens: 1 }, { ...missing, total_tokens: -1 },
    { prompt_tokens: -1, completion_tokens: 5 }, { prompt_tokens: '10', completion_tokens: 5 },
    { prompt_tokens: 1.5, completion_tokens: 5 }, { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 5 }]) {
    const json = chatToResponses(complete(usage), 'test');
    const { result, recorded } = await streamed(usage);
    assert.equal(json.status, 'completed'); assert.equal(result.status, 'completed');
    assert.equal(json.usage, undefined); assert.equal(result.usage, undefined); assert.equal(recorded.length, 0);
  }
});

test('invalid or conflicting optional detail is omitted without failing a valid answer', async () => {
  const base = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  for (const detail of [{ prompt_cache_hit_tokens: 11 }, { prompt_cache_hit_tokens: -1 },
    { prompt_cache_hit_tokens: 7, prompt_tokens_details: { cached_tokens: 6 } },
    { prompt_cache_hit_tokens: 7, prompt_cache_miss_tokens: 4 }, { prompt_tokens_details: { cached_tokens: '7' } },
    { completion_tokens_details: { reasoning_tokens: 6 } }, { completion_tokens_details: { reasoning_tokens: -1 } }]) {
    const usage = { ...base, ...detail };
    for (const result of [chatToResponses(complete(usage), 'test'), (await streamed(usage)).result]) {
      assert.equal(result.status, 'completed');
      assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15 });
    }
  }
});


test('nonfinite, unsafe and nonnumeric counts never become fabricated usage', () => {
  for (const value of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, -1, 0.25, '10', true, {}, null]) {
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, [key]: value };
      assert.equal(chatUsageToResponses(usage), undefined, `${key}: ${String(value)}`);
    }
  }
  for (const usage of [[], 'PRIVATE_FIXTURE', 123, true]) assert.equal(chatUsageToResponses(usage), undefined);
});

test('valid optional groups survive independently and normalization never mutates input', () => {
  const original = structuredClone(detailed);
  assert.deepEqual(chatUsageToResponses(detailed), expected);
  assert.deepEqual(detailed, original);
  assert.deepEqual(chatUsageToResponses({ ...detailed, prompt_cache_miss_tokens: 4 }), {
    input_tokens: 10, output_tokens: 5, total_tokens: 15, output_tokens_details: { reasoning_tokens: 3 } });
  assert.deepEqual(chatUsageToResponses({ ...detailed, completion_tokens_details: { reasoning_tokens: 6 } }), {
    input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 7 } });
});
