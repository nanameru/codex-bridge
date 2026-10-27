/** Read-only reconstruction of a matching checkpoint from the owner's Codex log. */
import { constants } from 'node:fs';
import { lstat, readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { HandoffError } from './compaction-handoff.mjs';

const LIMIT = 64 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const failure = () => Object.assign(new HandoffError('元の会話ログから安全に復元できません。ログの欠落・分岐・巻き戻し・サイズ・権限を確認してください。暗号化履歴は保持しています。OpenAIは使用していません。'), { status: 422 });
async function directory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022)) throw failure();
}

export async function restoreRolloutHistory(body, { root, threadId, signal }) {
  try {
    if (!UUID.test(threadId ?? '') || !Array.isArray(body.input)) throw failure();
    const end = body.input.findLastIndex(item => item.type === 'compaction');
    const opaque = body.input[end]?.encrypted_content;
    if (typeof opaque !== 'string' || !opaque || end >= body.input.length - 1) throw failure();
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
    if (candidates.length !== 1) throw failure();
    const fd = await open(candidates[0], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let source;
    try {
      const info = await fd.stat();
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o022) || info.nlink !== 1 || info.size > LIMIT) throw failure();
      // Read only the size validated above, even if another process appends now.
      const buffer = Buffer.alloc(info.size);
      let read = 0;
      while (read < buffer.length) {
        signal?.throwIfAborted();
        const part = await fd.read(buffer, read, buffer.length - read, read);
        if (!part.bytesRead) throw failure();
        read += part.bytesRead;
      }
      source = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } finally { await fd.close(); }
    const restored = [];
    let meta = false, found = false, firstCompaction = true, hasUser = false;
    const lines = source.split('\n');
    // An active writer may be midway through its final line. Never use it.
    if (!source.endsWith('\n')) lines.pop();
    let lineNumber = 0;
    for (const line of lines) {
      if (++lineNumber % 512 === 0) await new Promise(resolve => setImmediate(resolve));
      signal?.throwIfAborted();
      if (!line.trim()) continue;
      const event = JSON.parse(line), item = event.payload;
      if (event.type === 'session_meta') {
        if (meta || item?.id !== threadId || item.forked_from_id) throw failure();
        meta = true;
      }
      if (!meta) throw failure();
      if (/rollback|rolled_back/i.test(event.type) || event.type === 'event_msg' && /rollback|rolled_back/i.test(item?.type ?? '')) throw failure();
      if (found) continue;
      if (event.type === 'compacted') {
        if (firstCompaction && !hasUser) throw failure();
        firstCompaction = false;
        // Do not replay replacement_history: it repeats originals or carries opaque state.
        if (item?.replacement_history?.some(value => value.type === 'compaction' && value.encrypted_content === opaque)) {
          found = true; continue;
        }
      }
      if (event.type !== 'response_item') continue;
      if (item?.type === 'compaction') {
        if (!hasUser) throw failure();
        if (item.encrypted_content === opaque) { found = true; continue; }
        continue;
      }
      if (item?.type === 'reasoning') continue; // Internal reasoning is not recoverable conversation text.
      if (item?.type === 'compaction_trigger') continue;
      if (!item || typeof item.type !== 'string') throw failure();
      if (item.role === 'user') hasUser = true;
      restored.push(item);
    }
    if (!found || !hasUser || !restored.length) throw failure();
    // Current directives override old directives. Never change the on-disk rollout.
    const directives = body.input.slice(0, end + 1).filter(item => ['system', 'developer'].includes(item.role));
    const original = restored.filter(item => !['system', 'developer'].includes(item.role));
    return { body: { ...body, input: [...directives, ...original, ...body.input.slice(end + 1)] },
      prefixEnd: directives.length + original.length };
  } catch (error) {
    if (signal?.aborted) throw error;
    throw failure(); // Do not disclose transcript content, paths, or parser details.
  }
}
