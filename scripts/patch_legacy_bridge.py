import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import textwrap
import time

from switch_config import atomic_write


IMPORT = 'import { reasoningOptions, upstreamSession } from "./upstream-options.mjs";'
GUARD_IMPORT = 'import { createRequestGuard } from "./request-guard.mjs";'
PREVIOUS_HELPER_SHA256 = "48f7007270ccdbca4cb6658d339e518421b9f17806e677bf5c1705c7783cde13"

GUARD_OLD = textwrap.dedent("""\
    // ---- 暴走ガード -------------------------------------------------
    // 同一プロセスから短時間に大量リクエストが来たら止める。
    // 実APIで事故ると一瞬で課金が飛ぶため、既定で有効。
    const MAX_REQ_PER_MIN = Number(process.env.MAX_REQ_PER_MIN ?? 40);
    const recent = [];
    function guardTripped() {
      const now = Date.now();
      while (recent.length && now - recent[0] > 60_000) recent.shift();
      recent.push(now);
      return recent.length > MAX_REQ_PER_MIN;
    }""")

GUARD_NEW = textwrap.dedent("""\
    // ---- 暴走ガード -------------------------------------------------
    // 同一スレッドから短時間に大量リクエストが来たら止める。
    // 実APIで事故ると一瞬で課金が飛ぶため、既定で有効。
    const MAX_REQ_PER_MIN = numberEnv("MAX_REQ_PER_MIN", 40, 1);
    // 0 は無効。多数スレッドの同時利用に備える場合だけ設定する。
    const MAX_REQ_PER_MIN_GLOBAL = numberEnv("MAX_REQ_PER_MIN_GLOBAL", 0, 0);
    const requestGuard = createRequestGuard({
      maxPerThread: MAX_REQ_PER_MIN,
      maxGlobal: MAX_REQ_PER_MIN_GLOBAL,
    });""")

CALLSITE_OLD = textwrap.indent(textwrap.dedent("""\
    if (guardTripped()) {
      log(`!! 暴走ガード作動（1分間に ${recent.length} 回）。429 を返します`);
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          type: "rate_limit_exceeded",
          message: `codex-bridge: 1分間に ${MAX_REQ_PER_MIN} 回を超えました。ループの可能性があるため停止しました。`,
        },
      }));
      return;
    }

    const model = body.model || DEFAULT_MODEL;
    const threadId = threadIdOf(body);
    """), "      ")

CALLSITE_NEW = textwrap.indent(textwrap.dedent("""\
    const model = body.model || DEFAULT_MODEL;
    const threadId = threadIdOf(body);
    const guard = requestGuard.check(threadId);
    if (!guard.allowed) {
      const scope = guard.scope === "global" ? "全体" : `スレッド ${String(threadId).slice(0, 8)}`;
      log(`!! 暴走ガード作動（${scope} / 1分間に ${guard.count} 回 / 上限 ${guard.limit}）。429 を返します`);
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": String(guard.retryAfterSeconds),
      });
      res.end(JSON.stringify({
        error: {
          type: "rate_limit_exceeded",
          message: `codex-bridge: ${guard.scope === "global" ? "全体で" : "このスレッドで"}1分間に ${guard.limit} 回を超えました。${guard.retryAfterSeconds} 秒後に再試行してください。`,
        },
      }));
      return;
    }
    """), "      ")

HELPERS = (
    ("upstream-options.mjs", "src/upstream-options.mjs", PREVIOUS_HELPER_SHA256),
    ("request-guard.mjs", "src/request-guard.mjs", None),
)

REPLACEMENTS = [
    ('presence_penalty: 0.1,', 'presence_penalty: 0.1,\n        ...reasoningOptions(model, body.reasoning?.effort),', 1),
    ('async function doFetch(path, bodyObj, token, clientSignal) {',
     'async function doFetch(path, bodyObj, token, clientSignal, sessionId) {', 1),
    ('"x-opencode-session": SESSION_ID,', '"x-opencode-session": sessionId ?? SESSION_ID,', 1),
    ('doFetch("/chat/completions", chatBody, authInfo.token, clientAbort.signal)',
     'doFetch("/chat/completions", chatBody, authInfo.token, clientAbort.signal, upstreamSession(body, SESSION_ID))', 2),
    ('doFetch("/responses", { ...body, model }, authInfo.token, clientAbort.signal)',
     'doFetch("/responses", { ...body, model }, authInfo.token, clientAbort.signal, upstreamSession(body, SESSION_ID))', 1),
    (GUARD_OLD, GUARD_NEW, 1),
    (CALLSITE_OLD, CALLSITE_NEW, 1),
]


def with_imports(source):
    if GUARD_IMPORT in source:
        if IMPORT not in source:
            raise ValueError("本番ブリッジの形式が想定と異なります。何も更新していません")
        return source
    if IMPORT in source:
        return source.replace(IMPORT, IMPORT + "\n" + GUARD_IMPORT, 1)
    anchor = 'import http from "node:http";'
    if source.count(anchor) != 1:
        raise ValueError("本番ブリッジの形式が想定と異なります。何も更新していません")
    return source.replace(anchor, IMPORT + "\n" + GUARD_IMPORT + "\n" + anchor, 1)


ERROR_HEADERS = ('res.writeHead(attempt.upstream.status, { "content-type": "application/json" });',
                 'res.writeHead(attempt.upstream.status, { "content-type": "application/json",\n'
                 '            ...(attempt.upstream.headers.has("retry-after") ? { "retry-after": attempt.upstream.headers.get("retry-after") } : {}) });')


def patched_source(source):
    old_headers, new_headers = ERROR_HEADERS
    if source.count(old_headers) == 1 and new_headers not in source:
        source = source.replace(old_headers, new_headers)
    source = with_imports(source)
    for old, new, count in REPLACEMENTS:
        if source.count(new) == count:
            continue
        if source.count(old) != count:
            raise ValueError("本番ブリッジの形式が想定と異なります。何も更新していません")
        source = source.replace(old, new)
    return source


def prepare(target):
    if target.is_symlink() or target.parent.is_symlink():
        raise ValueError("シンボリックリンク先は更新できません")
    helpers = []
    for name, source_path, previous_sha256 in HELPERS:
        module = target.with_name(name)
        helper = Path(__file__).resolve().parents[1] / source_path
        if module.is_symlink():
            raise ValueError(f"既存の{name}は上書きしません")
        if module.exists() and module.read_bytes() != helper.read_bytes():
            if previous_sha256 is None or hashlib.sha256(module.read_bytes()).hexdigest() != previous_sha256:
                raise ValueError(f"既存の{name}は上書きしません")
        helpers.append((module, helper.read_text()))
    source = target.read_text()
    updated = patched_source(source)
    subprocess.run([shutil.which("node") or "node", "--check", "--input-type=module"],
                   input=updated, text=True, capture_output=True, check=True)
    return source, updated, helpers


def main():
    parser = argparse.ArgumentParser(description="本番8788の既存修正を保持して推論設定・会話セッション・暴走ガードだけ更新する")
    parser.add_argument("target", type=Path)
    parser.add_argument("--apply", action="store_true")
    arguments = parser.parse_args()
    source, updated, helpers = prepare(arguments.target)
    if not arguments.apply:
        print("適用可能です（確認のみ）。--applyでバックアップ後に更新します。再起動は行いません。")
        return
    if arguments.target.read_text() != source:
        raise ValueError("確認後に元ファイルが変更されました。更新を中止します")
    if source != updated:
        backup = arguments.target.with_name(arguments.target.name + ".bak.latency." + str(time.time_ns()))
        atomic_write(backup, source)
    for module, helper in helpers:
        if module.exists() and module.read_text() != helper:
            backup = module.with_name(module.name + ".bak.latency." + str(time.time_ns()))
            atomic_write(backup, module.read_text())
            atomic_write(module, helper)
        elif not module.exists():
            atomic_write(module, helper)
    if source != updated:
        atomic_write(arguments.target, updated, arguments.target.stat().st_mode & 0o777)
    print("推論設定・会話セッション・暴走ガードのファイル更新を確認しました。プロセスは再起動していません。")


if __name__ == "__main__":
    main()
