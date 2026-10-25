// No network fetch implementation: every inference is synthetic and local.
import { once } from 'node:events';
import { createRouter } from '../src/model-router.mjs';
const mode = process.env.STREAM_ERROR_TEST_MODE ?? 'reset';
let calls = 0;
const router = createRouter({
  catalog: { models: [{ slug: 'gpt-6.1-sol', router_provider: 'openai' }] },
  nativeBase: 'http://127.0.0.1:1/v1', allowTestOrigins: true,
  authenticate: request => request.headers.authorization === 'Bearer synthetic-stream-key',
  timeoutMs: mode === 'timeout' ? 150 : 2000,
  fetcher: async url => {
    if (new URL(url).hostname !== '127.0.0.1') throw new Error('external URL blocked');
    calls++;
    return new Response(new ReadableStream({ start(controller) {
      const response = { id: 'resp_stream_probe', object: 'response', created_at: 1,
        model: 'gpt-6.1-sol', status: 'in_progress', output: [], error: null };
      controller.enqueue(new TextEncoder().encode('event: response.created\ndata: '
        + JSON.stringify({ type: 'response.created', sequence_number: 0, response }) + '\n\n'));
      if (mode === 'reset') setTimeout(() => controller.error(new Error('PRIVATE_STREAM_PROBE')), 60);
    } }), { headers: { 'content-type': 'text/event-stream' } });
  },
  onMetric: metric => console.log(JSON.stringify({ outcome: metric.outcome,
    reason: metric.termination_reason, calls })),
});
router.listen(0, '127.0.0.1'); await once(router, 'listening');
console.log(JSON.stringify({ url: `http://127.0.0.1:${router.address().port}/v1` }));
process.stdin.resume();
process.stdin.once('end', () => { router.closeAllConnections(); router.close(); });
