"""Patch only known ingress/logging fragments; preserve legacy reasoning and timeout fixes."""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import time

from switch_config import atomic_write

IMPORT = 'import { guardBridgeRequest, validateOpenCodeBase, fetchOpenCode, readOpenCodeApiKey } from "./local-security.mjs";'
AUTH_START = '/**\n * 認証トークンの取得。'
AUTH_SHA256 = "ae0def886d8ade611197decae4a20f830e58ee8afa72dc72cdd7860f98fe6908"
AUTH_REPLACEMENT = '''// OpenCode API credential source (managed; no OAuth database).
function getToken() {
  const token = readOpenCodeApiKey();
  return { token, kind: token ? "api_key" : "none" };
}

'''
OLD_SERVER = 'const server = http.createServer(async (req, res) => {'
NEW_SERVER = OLD_SERVER + '\n  if (!guardBridgeRequest(req, res)) return;'
REPLACEMENTS = [
    ('import http from "node:http";', IMPORT + '\nimport http from "node:http";'),
    (OLD_SERVER, NEW_SERVER),
    ('const UPSTREAM_BASE = (process.env.UPSTREAM_BASE ?? "https://opencode.ai/inference/go/openai/v1").replace(/\\/+$/, "");',
     'const UPSTREAM_BASE = validateOpenCodeBase((process.env.UPSTREAM_BASE ?? "https://opencode.ai/inference/go/openai/v1").replace(/\\/+$/, ""));'),
    ('const upstream = await fetch(`${UPSTREAM_BASE}${path}`, {',
     'const upstream = await fetchOpenCode(`${UPSTREAM_BASE}${path}`, {'),
    ('const DUMP_DISABLED = process.env.DISABLE_DUMP === "1";',
     'const DUMP_DISABLED = process.env.ALLOW_REQUEST_DUMP !== "1" || process.env.DISABLE_DUMP === "1";'),
    ('log("upstream", attempt.upstream.status, t.slice(0, 200));', 'log("upstream", attempt.upstream.status);'),
]


def patched_source(source):
    if IMPORT in source:
        # Other managed patches may insert imports before node:http. Verify
        # the security import itself, not incidental adjacency to that import.
        if (source.count(IMPORT) == 1
                and all(source.count(new) == 1 for _, new in REPLACEMENTS[1:])
                and source.count(AUTH_REPLACEMENT) == 1):
            return source
        raise ValueError("部分的なセキュリティ更新です。変更しません")
    for old, new in REPLACEMENTS:
        if source.count(old) != 1:
            raise ValueError("未対応の旧ブリッジです。変更しません")
        source = source.replace(old, new)
    if source.count(AUTH_START) != 1:
        raise ValueError("未対応の認証実装です。変更しません")
    start = source.index(AUTH_START)
    end = source.index("const log =", start)
    if hashlib.sha256(source[start:end].encode()).hexdigest() != AUTH_SHA256:
        raise ValueError("認証実装が変更されています。変更しません")
    source = source[:start] + AUTH_REPLACEMENT + source[end:]
    return source


def prepare(target):
    if target.is_symlink() or target.parent.is_symlink():
        raise ValueError("リンク先には適用できません")
    helper = Path(__file__).resolve().parents[1] / "src/local-security.mjs"
    module = target.with_name("local-security.mjs")
    manifest = module.with_name(".local-security.sha256")
    if module.is_symlink() or manifest.is_symlink():
        raise ValueError("異なる既存のセキュリティヘルパーは上書きしません")
    if module.exists() and module.read_bytes() != helper.read_bytes():
        if not manifest.exists() or manifest.read_text().strip() != hashlib.sha256(module.read_bytes()).hexdigest():
            raise ValueError("管理外のセキュリティヘルパーは上書きしません")
    source = target.read_text()
    updated = patched_source(source)
    subprocess.run([shutil.which("node") or "node", "--check", "--input-type=module"],
                   input=updated, text=True, capture_output=True, check=True)
    return source, updated, module, helper.read_text()


def apply(target):
    source, updated, module, helper = prepare(target)
    if target.read_text() != source:
        raise ValueError("確認中にファイルが変更されました")
    backup = None
    if source != updated:
        backup = target.with_name(target.name + ".bak.security." + str(time.time_ns()))
        atomic_write(backup, source)
    if module.exists() and module.read_text() != helper:
        atomic_write(module.with_name(module.name + ".bak.security." + str(time.time_ns())), module.read_text())
    if not module.exists() or module.read_text() != helper:
        atomic_write(module, helper)
    manifest = module.with_name(".local-security.sha256")
    managed_hash = hashlib.sha256(helper.encode()).hexdigest() + "\n"
    if not manifest.exists() or manifest.read_text() != managed_hash:
        atomic_write(manifest, managed_hash)
    if source != updated:
        atomic_write(target, updated, target.stat().st_mode & 0o777)
    return backup


def main():
    parser = argparse.ArgumentParser(description="旧ブリッジの認証とログだけ更新する（再起動なし）")
    parser.add_argument("target", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    prepare(args.target)
    if args.apply:
        backup = apply(args.target)
        print("ファイル更新済み。" + (f"バックアップ: {backup}" if backup else "変更なし。"))
    else:
        print("適用可能です。--applyで更新します。再起動は別途必要です。")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError):
        raise SystemExit("旧ブリッジの安全な更新を確認できません。既存ファイルとバックアップを確認してください")
