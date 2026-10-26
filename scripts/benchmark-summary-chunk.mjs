// Synthetic data only; no API, credentials, configuration or real transcript.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { takeSummaryChunk } from '../src/compaction-handoff.mjs';

const history = Array.from({ length: 4096 }, (_, i) => ({ role: 'user', content: `${i}:` + 'synthetic-日本語 '.repeat(25) }));
const limit = Buffer.byteLength(JSON.stringify(history.slice(0, 3000)));
function measure(select) {
  const queue = [...history];
  let calls = 0, measuredBytes = 0;
  const fits = input => {
    calls++;
    const bytes = Buffer.byteLength(JSON.stringify(input));
    measuredBytes += bytes;
    return bytes <= limit;
  };
  const start = performance.now();
  const chunk = select(queue, fits);
  const ms = performance.now() - start;
  assert.deepEqual(chunk, history.slice(0, 3000));
  assert.deepEqual(queue, history.slice(3000));
  return { measurements: calls, measured_bytes: measuredBytes, elapsed_ms: Math.round(ms * 100) / 100 };
}
const before = measure((queue, fits) => {
  const chunk = [];
  while (queue.length && fits([...chunk, queue[0]])) chunk.push(queue.shift());
  return chunk;
});
const after = measure((queue, fits) => takeSummaryChunk(queue, '', fits).chunk);
console.log(JSON.stringify({ before, after, note: 'Local chunk selection only; not end-to-end model latency.' }, null, 2));
