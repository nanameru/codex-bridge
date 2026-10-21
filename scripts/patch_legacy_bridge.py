import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import time

from switch_config import atomic_write


IMPORT = 'import { reasoningOptions, upstreamSession } from "./upstream-options.mjs";'
PREVIOUS_HELPER_SHA256 = "48f7007270ccdbca4cb6658d339e518421b9f17806e677bf5c1705c7783cde13"
REPLACEMENTS = [
    ('import http from "node:http";', IMPORT + '\nimport http from "node:http";', 1),
    ('presence_penalty: 0.1,', 'presence_penalty: 0.1,\n        ...reasoningOptions(model, body.reasoning?.effort),', 1),
    ('async function doFetch(path, bodyObj, token, clientSignal) {',
     'async function doFetch(path, bodyObj, token, clientSignal, sessionId) {', 1),
    ('"x-opencode-session": SESSION_ID,', '"x-opencode-session": sessionId ?? SESSION_ID,', 1),
    ('doFetch("/chat/completions", chatBody, authInfo.token, clientAbort.signal)',
     'doFetch("/chat/completions", chatBody, authInfo.token, clientAbort.signal, upstreamSession(body, SESSION_ID))', 2),
    ('doFetch("/responses", { ...body, model }, authInfo.token, clientAbort.signal)',
     'doFetch("/responses", { ...body, model }, authInfo.token, clientAbort.signal, upstreamSession(body, SESSION_ID))', 1),
]


def patched_source(source):
    if IMPORT in source:
        if all(source.count(new) == count for _old, new, count in REPLACEMENTS):
            return source
        raise ValueError("部分的な変更または未対応の版です。何も更新していません")
    for old, new, count in REPLACEMENTS:
        if source.count(old) != count:
            raise ValueError("本番ブリッジの形式が想定と異なります。何も更新していません")
        source = source.replace(old, new)
    return source


def prepare(target):
    if target.is_symlink() or target.parent.is_symlink():
        raise ValueError("シンボリックリンク先は更新できません")
    module = target.with_name("upstream-options.mjs")
    helper = Path(__file__).resolve().parents[1] / "src/upstream-options.mjs"
    if module.is_symlink():
        raise ValueError("既存のupstream-options.mjsは上書きしません")
    if module.exists() and module.read_bytes() != helper.read_bytes():
        if hashlib.sha256(module.read_bytes()).hexdigest() != PREVIOUS_HELPER_SHA256:
            raise ValueError("既存のupstream-options.mjsは上書きしません")
    source = target.read_text()
    updated = patched_source(source)
    subprocess.run([shutil.which("node") or "node", "--check", "--input-type=module"],
                   input=updated, text=True, capture_output=True, check=True)
    return source, updated, module, helper.read_text()


def main():
    parser = argparse.ArgumentParser(description="本番8788の既存修正を保持して推論設定と会話セッションだけ更新する")
    parser.add_argument("target", type=Path)
    parser.add_argument("--apply", action="store_true")
    arguments = parser.parse_args()
    source, updated, module, helper = prepare(arguments.target)
    if not arguments.apply:
        print("適用可能です（確認のみ）。--applyでバックアップ後に更新します。再起動は行いません。")
        return
    if arguments.target.read_text() != source:
        raise ValueError("確認後に元ファイルが変更されました。更新を中止します")
    if source != updated:
        backup = arguments.target.with_name(arguments.target.name + ".bak.latency." + str(time.time_ns()))
        atomic_write(backup, source)
    if module.exists() and module.read_text() != helper:
        backup = module.with_name(module.name + ".bak.latency." + str(time.time_ns()))
        atomic_write(backup, module.read_text())
        atomic_write(module, helper)
    elif not module.exists():
        atomic_write(module, helper)
    if source != updated:
        atomic_write(arguments.target, updated, arguments.target.stat().st_mode & 0o777)
    print("推論設定と会話セッションのファイル更新を確認しました。プロセスは再起動していません。")


if __name__ == "__main__":
    main()
