import assert from "node:assert/strict";
import test from "node:test";
import { takeSummaryChunk } from "../src/compaction-handoff.mjs";

test("large histories require logarithmic full-prefix measurements", () => {
  const history = Array.from({ length: 4096 }, (_, i) => ({ role: "user", content: `item-${i}` }));
  const queue = [...history];
  let measured = 0;
  const result = takeSummaryChunk(queue, "", items => { measured++; return items.length <= 3000; });
  assert.deepEqual(result.chunk, history.slice(0, 3000));
  assert.deepEqual(queue, history.slice(3000));
  assert.ok(measured <= 28, `full-prefix measurements: ${measured}`);
});

test("carry, whole-item boundaries, ordering and oversized Unicode fragments survive", () => {
  const queue = [{ role: "user", content: "a" }, { role: "user", content: "b" },
    { role: "user", content: "😀".repeat(20) }];
  const original = structuredClone(queue);
  const fits = items => items.reduce((n, item) => n + item.content.length, 0) <= 80;
  const first = takeSummaryChunk(queue, "carry", fits);
  assert.deepEqual(first.chunk, original.slice(0, 2));
  assert.equal(first.input.length, 3);
  const second = takeSummaryChunk(queue, "carry", fits);
  assert.ok(fits(second.input));
  assert.equal(second.chunk[0].content + queue[0].content, original[2].content);
  assert.ok(!/[\uD800-\uDBFF]$/.test(second.chunk[0].content));
});

test("rejecting indivisible encrypted content leaves queue untouched", () => {
  const queue = [{ type: "compaction", encrypted_content: "protected" }];
  const original = structuredClone(queue);
  assert.throws(() => takeSummaryChunk(queue, "", () => false), /暗号化履歴/);
  assert.deepEqual(queue, original);
});

test('growing-prefix search matches greedy boundaries under byte and token budgets', () => {
  for (const size of [0, 1, 2, 3, 8, 17, 65]) {
    const history = Array.from({ length: size }, (_, i) => ({ role: 'user', content: '日本語😀'.repeat(i % 9 + 1) }));
    for (let capacity = 0; capacity <= size; capacity++) {
      const limit = Buffer.byteLength(JSON.stringify(history.slice(0, capacity)));
      const fits = items => Buffer.byteLength(JSON.stringify(items)) <= limit;
      const queue = [...history];
      if (!capacity && size) continue; // Splitting a single item is tested separately.
      const result = takeSummaryChunk(queue, '', fits);
      assert.deepEqual(result.chunk, history.slice(0, capacity));
      assert.deepEqual(queue, history.slice(capacity));
    }
  }
});
