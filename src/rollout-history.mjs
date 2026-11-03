/** Read-only reconstruction of a matching checkpoint from the owner's Codex log. */
import { constants } from 'node:fs';
import { lstat, readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { HandoffError, budgetHistoryBoundary } from './compaction-handoff.mjs';

// Bound the on-disk scan separately from materialized conversation content.
const LIMIT = 512 * 1024 * 1024;
const CONTENT_LIMIT = 128 * 1024 * 1024;
const LINE_LIMIT = 32 * 1024 * 1024;
async function* snapshotLines(fd, size, signal) {
  const buffer = Buffer.alloc(256 * 1024);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let position = 0, pending = '';
  while (position < size) {
    signal?.throwIfAborted();
    const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (!bytesRead) throw failure();
    position += bytesRead;
    pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
    let start = 0, end;
    while ((end = pending.indexOf('\n', start)) >= 0) {
      if (Buffer.byteLength(pending.slice(start, end)) > LINE_LIMIT) throw failure();
      yield pending.slice(start, end);
      start = end + 1;
    }
    pending = pending.slice(start);
    if (Buffer.byteLength(pending) > LINE_LIMIT) throw failure();
  }
  // Incomplete final JSON/UTF-8 belongs to the active writer; never consume it.
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const RESTORE_REASONS = new Set(['invalid_log', 'invalid_thread_id', 'invalid_checkpoint', 'log_not_found',
  'ambiguous_log', 'unsafe_log', 'checkpoint_not_found', 'rollback_detected', 'metadata_mismatch']);
export class RolloutHistoryError extends HandoffError {
  constructor(reason) {
    super('元の会話ログから安全に復元できません。ログの欠落・分岐・巻き戻し・サイズ・権限を確認してください。暗号化履歴は保持しています。OpenAIは使用していません。残存情報と手動メモを新規会話へ渡すには python3 scripts/rescue_handoff.py --thread <会話ID> --memo <メモファイル> を利用してください。');
    this.status = 422;
    this.reason = RESTORE_REASONS.has(reason) ? reason : 'invalid_log';
  }
}
const failure = reason => new RolloutHistoryError(reason);
async function directory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022)) throw failure('unsafe_log');
}

export async function restoreRolloutHistory(body, { root, threadId, signal }) {
  return restoreHistory(body, { root, threadId, signal }, new Set());
}

async function restoreHistory(body, { root, threadId, signal, historyLimit }, ancestors) {
  try {
    if (ancestors.has(threadId) || ancestors.size >= 8) throw failure();
    ancestors = new Set([...ancestors, threadId]);
    if (!UUID.test(threadId ?? '')) throw failure('invalid_thread_id');
    if (!Array.isArray(body.input)) throw failure('invalid_checkpoint');
    const end = body.input.findLastIndex(item => item.type === 'compaction');
    const opaque = body.input[end]?.encrypted_content;
    if (typeof opaque !== 'string' || !opaque) throw failure('invalid_checkpoint');
    signal?.throwIfAborted();
    await directory(root);
    const candidates = [];
    let count = 0;
    async function find(path, depth) {
      await directory(path);
      for (const entry of await readdir(path, { withFileTypes: true })) {
        signal?.throwIfAborted();
        if (++count > 20000) throw failure();
        if (entry.name.endsWith(`-${threadId}.jsonl`)) {
          if (!entry.isFile()) throw failure();
          candidates.push(join(path, entry.name));
        } else if (depth && entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) await find(join(path, entry.name), depth - 1);
      }
    }
    // Archived logs are deliberately not scanned: active source must be unambiguous.
    await find(join(root, 'sessions'), 3);
    if (candidates.length !== 1) throw failure(candidates.length ? 'ambiguous_log' : 'log_not_found');
    const fd = await open(candidates[0], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await fd.stat();
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o022) || info.nlink !== 1 || info.size > LIMIT) throw failure('unsafe_log');
      const restored = [];
      let meta = false, parentId, historyBase, inheritedMeta = false, found = false, firstCompaction = true, hasUser = false, contentBytes = 0;
      let snapshotSize = info.size;
      if (historyLimit) {
        if (!Number.isSafeInteger(historyLimit.offset) || historyLimit.offset <= 0 || historyLimit.offset > info.size ||
            !Number.isSafeInteger(historyLimit.ordinal) || historyLimit.ordinal <= 0) throw failure('invalid_checkpoint');
        const last = Buffer.alloc(1);
        if ((await fd.read(last, 0, 1, historyLimit.offset - 1)).bytesRead !== 1 || last[0] !== 10) throw failure('invalid_checkpoint');
        snapshotSize = historyLimit.offset;
      }
      let lineNumber = 0;
      // Snapshot size is fixed at open; later appends never enter this request.
      for await (const line of snapshotLines(fd, snapshotSize, signal)) {
        if (++lineNumber % 512 === 0) await new Promise(resolve => setImmediate(resolve));
        signal?.throwIfAborted();
        if (!line.trim()) continue;
        const event = JSON.parse(line), item = event.payload;
        if (event.type === 'session_meta') {
          if (!meta) {
            if (item?.id !== threadId) throw failure('metadata_mismatch');
            parentId = item.forked_from_id;
            if (parentId != null && (!UUID.test(parentId) || parentId === threadId)) throw failure();
            historyBase = item.history_base;
            if (historyBase && (item.history_mode !== 'paginated' ||
                item.forked_from_ordinal_exclusive !== historyBase.end_ordinal_exclusive)) throw failure('invalid_checkpoint');
            meta = true;
          } else {
            // Native forks can prepend child metadata to the inherited parent log.
            if (!parentId || inheritedMeta || lineNumber !== 2 || item?.id !== parentId) throw failure();
            inheritedMeta = true;
          }
        }
        if (!meta) throw failure();
        if (/rollback|rolled_back/i.test(event.type) || event.type === 'event_msg' && /rollback|rolled_back/i.test(item?.type ?? '')) throw failure('rollback_detected');
        if (found) continue;
        if (event.type === 'compacted') {
          if (firstCompaction && !hasUser && !parentId) throw failure();
          firstCompaction = false;
          // Do not replay replacement_history: it repeats originals or carries opaque state.
          if (item?.replacement_history?.some(value => value.type === 'compaction' && value.encrypted_content === opaque)) {
            found = true; continue;
          }
        }
        if (event.type !== 'response_item') continue;
        if (item?.type === 'compaction') {
          if (!hasUser && !parentId) throw failure();
          if (item.encrypted_content === opaque) { found = true; continue; }
          continue;
        }
        if (item?.type === 'reasoning') continue; // Internal reasoning is not recoverable conversation text.
        if (item?.type === 'compaction_trigger') continue;
        if (!item || typeof item.type !== 'string') throw failure();
        if (item.role === 'user') hasUser = true;
        contentBytes += Buffer.byteLength(line);
        if (contentBytes > CONTENT_LIMIT) throw failure();
        restored.push(item);
      }
      if (historyLimit && lineNumber !== historyLimit.ordinal) throw failure('invalid_checkpoint');
      // Chained paginated boundaries require independent ordinal mapping.
      if (historyLimit && parentId) throw failure('invalid_checkpoint');
      if (!found && parentId && historyBase) {
        if (historyBase.thread_id !== parentId || !Number.isSafeInteger(historyBase.end_byte_offset) ||
            !Number.isSafeInteger(historyBase.end_ordinal_exclusive)) throw failure('invalid_checkpoint');
        // Do not silently lose child-side messages or tool results. Only replay
        // the parent prefix when the caller already carries every child item.
        const tail = body.input.slice(end + 1).map(value => JSON.stringify(value));
        for (const item of restored.filter(value => !['system', 'developer'].includes(value.role))) {
          const index = tail.indexOf(JSON.stringify(item));
          if (index < 0) throw failure('invalid_checkpoint');
          tail.splice(index, 1);
        }
        return await restoreHistory(body, { root, threadId: parentId, signal,
          historyLimit: { offset: historyBase.end_byte_offset, ordinal: historyBase.end_ordinal_exclusive } }, ancestors);
      }
      if (!found) throw failure('checkpoint_not_found');
      if (parentId) {
        // Never use replacement_history as a substitute for missing originals.
        // The parent must independently prove the exact requested checkpoint.
        return await restoreHistory(body, { root, threadId: parentId, signal }, ancestors);
      }
      if (!hasUser || !restored.length) throw failure();
      // Current directives override old directives. Never change the on-disk rollout.
      const directives = body.input.slice(0, end + 1).filter(item => ['system', 'developer'].includes(item.role));
      const original = restored.filter(item => !['system', 'developer'].includes(item.role));
      const input = [...directives, ...original, ...body.input.slice(end + 1)];
      // Mid-turn auto-compaction can leave the checkpoint as the final item.
      // Retain the latest task and its tool batch instead of summarizing every
      // restored item or inventing an extra user instruction.
      const boundary = end === body.input.length - 1 ? budgetHistoryBoundary(input) : directives.length + original.length;
      return { body: { ...body, input }, prefixEnd: boundary > 0 ? boundary : undefined };
    } finally { await fd.close(); }
  } catch (error) {
    if (signal?.aborted) throw error;
    throw error instanceof RolloutHistoryError ? error : failure(); // Never disclose parser details or content.
  }
}
