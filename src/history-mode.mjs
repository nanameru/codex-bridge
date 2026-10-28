/** Owner-local policy. Re-read on every request so changes need no router restart. */
import { lstatSync, mkdirSync, openSync, closeSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { codexRoot, readPrivateFile } from './local-security.mjs';

export const HISTORY_MODES = {
  selected: {
    label: '選択中のモデルで要約（既定）',
    notice: '保存された会話ログを選択中のモデルで要約し直します。外部モデル選択中は、この引き継ぎ要約でOpenAIの利用枠を消費しませんが、元ログの不足や再要約により、過去の指示・判断・細部が引き継がれない場合があります。選択モデルの要約分の利用量は発生します。',
  },
  openai: {
    label: 'OpenAIで引き継ぐ',
    notice: '暗号化履歴の読み取りと追加要約にOpenAIを使用します。会話がOpenAIにも送信され、追加の利用量が発生します。完全復元を保証するものではありません。',
  },
  ask: {
    label: '必要時に確認する',
    notice: '補助的な引き継ぎ要約が必要になったら停止します。selectedまたはopenaiを明示選択して再試行してください。自動でOpenAIには送信しません。',
  },
};
const FILE = 'bridge-history-mode.json';
export const modeHelp = 'Bridgeリポジトリで node src/history-mode.mjs --mode selected または --mode openai を実行して再試行してください。';

export function readHistoryMode(root = codexRoot()) {
  const source = readPrivateFile(root, FILE);
  if (source === null) {
    try { lstatSync(join(root, FILE)); } catch (error) { if (error.code === 'ENOENT') return 'selected'; }
    throw new Error('履歴モード設定の所有者・権限を確認してください');
  }
  const value = JSON.parse(source);
  if (!value || value.version !== 1 || !Object.hasOwn(HISTORY_MODES, value.mode)) throw new Error('履歴モード設定が不正です');
  return value.mode;
}

export function writeHistoryMode(root, mode) {
  if (!Object.hasOwn(HISTORY_MODES, mode)) throw new Error('未知の履歴モードです');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = lstatSync(root);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022)) throw new Error('安全な本人のCODEX_HOMEが必要です');
  readHistoryMode(root); // Never replace an unsafe file or a symlink.
  const temporary = join(root, `.${FILE}.${randomUUID()}`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ version: 1, mode }) + '\n');
    closeSync(fd); fd = undefined;
    renameSync(temporary, join(root, FILE));
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* Renamed successfully. */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 2 && args[0] === '--mode' && Object.hasOwn(HISTORY_MODES, args[1]))) {
      throw new Error('使い方: node src/history-mode.mjs [--mode selected|openai|ask]');
    }
    if (args.length) writeHistoryMode(codexRoot(), args[1]);
    const mode = readHistoryMode();
    console.log(JSON.stringify({ mode, ...HISTORY_MODES[mode], existing_threads_modified: false }, null, 2));
    console.log('設定は次の要求から反映されます。新規会話の文章圧縮は python3 scripts/portable_history.py --apply で設定します。');
  } catch { console.error('履歴モードを処理できません。selected / openai / ask と設定ファイルの所有者・権限を確認してください。'); process.exitCode = 1; }
}
