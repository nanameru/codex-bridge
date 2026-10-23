"""Use one validated Chat protocol implementation in repo and legacy bridges."""
import argparse
import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import time
from switch_config import atomic_write

IMPORT = 'import { chatToResponses, pipeChatStream, chatMessages } from "./chat-protocol.mjs";'
ROOT = Path(__file__).resolve().parents[1]


def patched_source(source):
    legacy = 'async function pipeStream(upstreamRes, res, model, threadId, abortHandle)' in source
    # Keep the surrounding legacy authentication, timeouts, request guard and usage UI.
    source = source.replace('import { chatToResponses, pipeChatStream } from \"./chat-protocol.mjs\";', IMPORT)
    messages = 'function toChatMessages(body) {\n  return chatMessages(body, reasoningOptions(body.model ?? DEFAULT_MODEL, body.reasoning?.effort).thinking?.type === \"enabled\");\n}\n'
    payload = 'function toResponsesPayload(chat, model) {\n  return chatToResponses(chat, model);\n}\n'
    options = '{ recordUsage, abortHandle, heartbeatMs: SSE_HEARTBEAT_MS, firstByteTimeoutMs: UPSTREAM_FIRST_BYTE_TIMEOUT_MS, idleTimeoutMs: UPSTREAM_IDLE_TIMEOUT_MS }' if legacy else '{ recordUsage }'
    signature = 'async function pipeStream(upstreamRes, res, model, threadId' + (', abortHandle' if legacy else '') + ')'
    pipe = signature + ' {\n  return pipeChatStream(upstreamRes, res, model, threadId, ' + options + ');\n}\n'
    if IMPORT not in source:
        if source.count('import http from "node:http";') != 1:
            raise ValueError('未対応のbridge形式です')
        source = source.replace('import http from "node:http";', IMPORT + '\nimport http from "node:http";', 1)
    for pattern, replacement in [
        (r'function toChatMessages\(body\) \{[\s\S]*?\n}\n', messages),
        (r'function toResponsesPayload\(chat, model\) \{[\s\S]*?\n}\n', payload),
        (r'async function pipeStream\(upstreamRes, res, model, threadId(?:, abortHandle)?\) \{[\s\S]*?\n}\n', pipe),
    ]:
        source, count = re.subn(pattern, lambda _match: replacement, source)
        if count != 1:
            raise ValueError('bridgeの関数境界が一致しません')
    # Effort is a provider option, not an instruction to keep rechecking tools.
    source = source.replace('high: "答える前に必ず手順を確認し、見落としがないか検証する。",', 'high: "",')
    return source


def apply(target):
    target = Path(target)
    if target.is_symlink() or target.parent.is_symlink():
        raise ValueError('リンク先を更新しません')
    before = target.read_text()
    after = patched_source(before)
    module = target.with_name('chat-protocol.mjs')
    helper = (ROOT / 'src/chat-protocol.mjs').read_text()
    manifest = target.with_name('.chat-protocol.sha256')
    if module.is_symlink() or manifest.is_symlink():
        raise ValueError('リンクされたhelperを更新しません')
    if module.exists() and module.read_text() != helper:
        if not manifest.exists() or manifest.read_text().strip() != hashlib.sha256(module.read_bytes()).hexdigest():
            raise ValueError('管理外のhelperを上書きしません')
    subprocess.run([shutil.which('node') or 'node', '--check', '--input-type=module'], input=after, text=True, capture_output=True, check=True)
    if target.read_text() != before:
        raise ValueError('元ソースが変更されました')
    for path, content in [(module, helper), (target, after)]:
        if path.exists() and path.read_text() == content:
            continue
        if path.exists():
            atomic_write(path.with_name(path.name + '.bak.chat-protocol.' + str(time.time_ns())), path.read_text())
        atomic_write(path, content, path.stat().st_mode & 0o777 if path.exists() else 0o600)
    atomic_write(manifest, hashlib.sha256(module.read_bytes()).hexdigest()+'\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('target', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.apply:
        apply(args.target)
        print('Chat protocol helperを配置しました。サービスは再起動していません。')
    else:
        patched_source(args.target.read_text())
        print('関数境界の確認のみ。--applyで配置します。')
