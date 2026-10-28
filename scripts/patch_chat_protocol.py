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
TOOL_IMPORT = 'import { chatToolContext, chatToolChoice, toolChoiceForTools, ToolSearchError } from "./tool-search.mjs";'
HELPERS = ('chat-protocol.mjs', 'tool-search.mjs', 'usage.mjs')
MANIFEST = '.chat-protocol.sha256'
ROOT = Path(__file__).resolve().parents[1]


def patched_source(source):
    legacy = bool(re.search(r'async function pipeStream\(upstreamRes, res, model, threadId, abortHandle(?:, toolContext)?\)', source))
    # Preserve surrounding authentication, raw-stream handling, timeouts, guard and usage UI.
    source = source.replace('import { chatToResponses, pipeChatStream } from "./chat-protocol.mjs";', IMPORT)
    if IMPORT not in source:
        if source.count('import http from "node:http";') != 1:
            raise ValueError('未対応のbridge形式です')
        source = source.replace('import http from "node:http";', IMPORT + '\nimport http from "node:http";', 1)
    if TOOL_IMPORT not in source:
        for old in ['import { chatToolContext } from "./tool-search.mjs";',
                    'import { chatToolContext, chatToolChoice } from "./tool-search.mjs";',
                    'import { chatToolContext, chatToolChoice, ToolSearchError } from "./tool-search.mjs";']:
            if old in source:
                source = source.replace(old, TOOL_IMPORT)
                break
        else:
            source = source.replace(IMPORT, IMPORT + '\n' + TOOL_IMPORT, 1)
    messages = 'function toChatMessages(body) {\n  return chatMessages(body, reasoningOptions(body.model ?? DEFAULT_MODEL, body.reasoning?.effort).thinking?.type === "enabled");\n}\n'
    tools = 'function toChatTools(body) {\n  return chatToolContext(body).tools;\n}\n'
    payload = 'function toResponsesPayload(chat, model, toolContext) {\n  return chatToResponses(chat, model, toolContext);\n}\n'
    options = '{ recordUsage, abortHandle, heartbeatMs: SSE_HEARTBEAT_MS, firstByteTimeoutMs: UPSTREAM_FIRST_BYTE_TIMEOUT_MS, idleTimeoutMs: UPSTREAM_IDLE_TIMEOUT_MS, toolContext }' if legacy else '{ recordUsage, toolContext }'
    signature = 'async function pipeStream(upstreamRes, res, model, threadId' + (', abortHandle' if legacy else '') + ', toolContext)'
    pipe = signature + ' {\n  return pipeChatStream(upstreamRes, res, model, threadId, ' + options + ');\n}\n'
    for pattern, replacement in [
        (r'function toChatMessages\(body\) \{[\s\S]*?\n}\n', messages),
        (r'function toChatTools\(body\) \{[\s\S]*?\n}\n', tools),
        (r'function toResponsesPayload\(chat, model(?:, toolContext)?\) \{[\s\S]*?\n}\n', payload),
        (r'async function pipeStream\(upstreamRes, res, model, threadId(?:, abortHandle)?(?:, toolContext)?\) \{[\s\S]*?\n}\n', pipe),
    ]:
        source, count = re.subn(pattern, lambda _match: replacement, source)
        if count != 1:
            raise ValueError('bridgeの関数境界が一致しません')
    # All input translation failures must be handled before issuing upstream I/O.
    if 'let messages, toolContext, toolChoice;' not in source:
        pattern = r'(?m)^([ \t]*)const messages = toChatMessages\(body\);$'
        def guard(match):
            indent = match[1]
            lines = ['let messages, toolContext, toolChoice;', 'try {',
                     '  toolContext = chatToolContext(body);',
                     '  toolChoice = chatToolChoice(body.tool_choice, toolContext);',
                     '  messages = toChatMessages(body);', '} catch (error) {',
                     '  res.writeHead(422, { "content-type": "application/json" });',
                     '  const toolFailure = error instanceof ToolSearchError;',
                     '  const message = toolFailure && error.reasonCode === "tool_choice_requires_tools"',
                     '    ? error.message',
                     '    : `ツール情報または履歴をChat形式へ変換できません（理由: ${toolFailure ? error.reasonCode : "chat_history_conversion_failed"}）。履歴は保持しています。`;',
                     '  res.end(JSON.stringify({error:{type:toolFailure ? "unsupported_tool_search" : "invalid_tool_history",',
                     '    code:toolFailure ? error.reasonCode : "chat_history_conversion_failed",',
                     '    message}}));',
                     '  return;', '}']
            return '\n'.join(indent + line for line in lines)
        source, count = re.subn(pattern, guard, source)
        if count != 1:
            raise ValueError('bridgeの入力変換境界が一致しません')
    # Upgrade the previous managed catch without touching unrelated guards.
    previous_failure = (r'(?m)^([ \t]*)} catch \{\n\1  '
                        + re.escape('res.writeHead(422, { "content-type": "application/json" });')
                        + r'\n\1  '
                        + re.escape('res.end(JSON.stringify({error:{type:"unsupported_tool_search",message:"このツール検索または履歴はChat経路で安全に変換できません。履歴は保持しています。"}}));'))
    def improve_failure(match):
        lines = ['} catch (error) {',
                 '  res.writeHead(422, { "content-type": "application/json" });',
                 '  const toolFailure = error instanceof ToolSearchError;',
                 '  const message = toolFailure && error.reasonCode === "tool_choice_requires_tools"',
                 '    ? error.message',
                 '    : `ツール情報または履歴をChat形式へ変換できません（理由: ${toolFailure ? error.reasonCode : "chat_history_conversion_failed"}）。履歴は保持しています。`;',
                 '  res.end(JSON.stringify({error:{type:toolFailure ? "unsupported_tool_search" : "invalid_tool_history",',
                 '    code:toolFailure ? error.reasonCode : "chat_history_conversion_failed",',
                 '    message}}));']
        return '\n'.join(match[1] + line for line in lines)
    source = re.sub(previous_failure, improve_failure, source)
    if source.count('const toolFailure = error instanceof ToolSearchError;') != 1:
        raise ValueError('bridgeの診断境界が一致しません')
    raw_choice = 'if (body.tool_choice) chatBody.tool_choice = body.tool_choice;'
    desired_choice = 'if (toolChoice !== undefined) chatBody.tool_choice = toolChoice;'
    if raw_choice in source:
        source = source.replace(raw_choice, desired_choice)
    source = source.replace('if (toolChoice) chatBody.tool_choice = toolChoice;', desired_choice)
    if source.count(desired_choice) != 1:
        raise ValueError('bridgeのtool_choice境界が一致しません')
    # The Responses fallback bypasses Chat conversion; apply the same guard.
    legacy_fallback = 'upstream = await doFetch("/responses", { ...body, model });'
    if 'const responsesBody = { ...body, model };' not in source and legacy_fallback in source:
        pattern = r'(?m)^([ \t]*)' + re.escape(legacy_fallback) + r'$'
        def fallback_guard(match):
            indent = match[1]
            lines = ['const responsesBody = { ...body, model };',
                     'const responsesChoice = toolChoiceForTools(body.tool_choice, body.tools);',
                     'if (responsesChoice === undefined) delete responsesBody.tool_choice;',
                     'else responsesBody.tool_choice = responsesChoice;',
                     'upstream = await doFetch("/responses", responsesBody);']
            return '\n'.join(indent + line for line in lines)
        source, count = re.subn(pattern, fallback_guard, source)
        if count != 1:
            raise ValueError('bridgeのResponsesフォールバック境界が一致しません')
    source = source.replace('const payload = toResponsesPayload(chat, model);',
                            'const payload = toResponsesPayload(chat, model, toolContext);')
    call_pattern = r'await pipeStream\(([^,\n]+), res, model, threadId(?:, activeHandle)?(?:, toolContext)?\);'
    def call(match):
        return 'await pipeStream(' + match[1] + ', res, model, threadId' + (', activeHandle' if legacy else '') + ', toolContext);'
    source, count = re.subn(call_pattern, call, source)
    if count != 1:
        raise ValueError('bridgeのstream呼び出し境界が一致しません')
    if source.count('const payload = toResponsesPayload(chat, model, toolContext);') != 1:
        raise ValueError('bridgeの非stream呼び出し境界が一致しません')
    # Effort is a provider option, not an instruction to keep rechecking tools.
    source = source.replace('high: "答える前に必ず手順を確認し、見落としがないか検証する。",', 'high: "",')
    return source


def read_manifest(path):
    if not path.exists():
        return {}
    content = path.read_text().strip()
    # Migrate the original one-helper manifest without taking ownership of any
    # other pre-existing helper. Future manifests cover the complete dependency set.
    if re.fullmatch(r'[a-f0-9]{64}', content):
        return {'chat-protocol.mjs': content}
    result = {}
    for line in content.splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  ([a-z-]+\.mjs)', line)
        if not match or match[2] not in HELPERS or match[2] in result:
            raise ValueError('helper manifestの形式が不正です')
        result[match[2]] = match[1]
    if set(result) != set(HELPERS):
        raise ValueError('helper manifestの依存が不完全です')
    return result


def apply(target):
    target = Path(target)
    if target.is_symlink() or target.parent.is_symlink():
        raise ValueError('リンク先を更新しません')
    before = target.read_text()
    after = patched_source(before)
    helpers = {name: (ROOT / 'src' / name).read_text() for name in HELPERS}
    manifest = target.with_name(MANIFEST)
    if manifest.is_symlink() or any(target.with_name(name).is_symlink() for name in HELPERS):
        raise ValueError('リンクされたhelperを更新しません')
    previous = read_manifest(manifest)
    for name, helper in helpers.items():
        module = target.with_name(name)
        if module.exists() and module.read_text() != helper:
            if previous.get(name) != hashlib.sha256(module.read_bytes()).hexdigest():
                raise ValueError('管理外のhelperを上書きしません')
    node = shutil.which('node') or 'node'
    for content in [after, *helpers.values()]:
        subprocess.run([node, '--check', '--input-type=module'], input=content, text=True, capture_output=True, check=True)
    if target.read_text() != before:
        raise ValueError('元ソースが変更されました')
    for path, content in [*((target.with_name(name), content) for name, content in helpers.items()), (target, after)]:
        if path.exists() and path.read_text() == content:
            continue
        if path.exists():
            atomic_write(path.with_name(path.name + '.bak.chat-protocol.' + str(time.time_ns())), path.read_text())
        atomic_write(path, content, path.stat().st_mode & 0o777 if path.exists() else 0o600)
    content = ''.join(hashlib.sha256(helpers[name].encode()).hexdigest() + '  ' + name + '\n' for name in HELPERS)
    if not manifest.exists() or manifest.read_text() != content:
        atomic_write(manifest, content)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('target', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.apply:
        apply(args.target)
        print('Chat protocol helperと依存を配置しました。サービスは再起動していません。')
    else:
        patched_source(args.target.read_text())
        print('関数境界の確認のみ。--applyで配置します。')
