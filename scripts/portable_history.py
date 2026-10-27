"""Use Codex's standard plaintext compaction for new unified threads; preview by default."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import tomllib

from local_security import private_read, verify_service
from switch_config import atomic_write
from unified_config import edit_table

PROVIDER = "codex-bridge"
BACKUP_PREFIX = "config.toml.bak.portable-history."


def read_catalog(root):
    path = root / "unified-model-catalog.json"
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("統合カタログの通常ファイルを準備してください")
    catalog = json.loads(path.read_text())
    models = catalog.get("models") if isinstance(catalog, dict) else None
    if not isinstance(models, list) or not models or len(models) > 1000:
        raise ValueError("統合カタログの形式が不正です")
    if any(not isinstance(m, dict) or not isinstance(m.get("slug"), str)
           or m.get("router_provider") not in ("openai", "opencode", "commandcode", "ollama", "whatstoken") for m in models):
        raise ValueError("統合カタログの経路が不正です")
    if len({m["slug"] for m in models}) != len(models):
        raise ValueError("統合カタログに重複があります")
    return models


def candidate_config(source, root, models):
    config = tomllib.loads(source)
    if config.get("model_provider", "openai") not in ("openai", PROVIDER):
        raise ValueError("独自providerは変更しません")
    if config.get("model_catalog_json") != str(root / "unified-model-catalog.json"):
        raise ValueError("先に統合カタログとrouterを有効にしてください")
    if config.get("model") not in {m["slug"] for m in models}:
        raise ValueError("既定モデルが統合カタログにありません")
    providers = config.get("model_providers", {})
    if not isinstance(providers, dict) or not isinstance(providers.get(PROVIDER), dict):
        raise ValueError("統合providerの形式が不正です")
    provider = providers[PROVIDER]
    if not isinstance(provider.get("http_headers", {}), dict) or not isinstance(provider.get("capabilities", {}), dict):
        raise ValueError("統合providerの付加設定が不正です")
    if (provider.get("base_url") not in ("http://127.0.0.1:8790/v1", "http://127.0.0.1:8791/v1")
            or provider.get("name") in (None, "OpenAI")
            or provider.get("requires_openai_auth") is not True
            or provider.get("wire_api") != "responses"
            or any(provider.get(k) for k in ("env_key", "auth", "experimental_bearer_token"))):
        raise ValueError("本人認証を使う既存の統合providerを確認してください")
    marker = provider.get("http_headers", {}).get("x-codex-bridge-direct")
    if marker not in (None, "1"):
        raise ValueError("未知の直結設定は変更しません")
    # Preserve the active local router, including installations migrated to 8791.
    active_url = config.get("openai_base_url", provider["base_url"])
    if active_url not in ("http://127.0.0.1:8790/v1", "http://127.0.0.1:8791/v1"):
        raise ValueError("未知の接続先は変更しません")
    candidate = edit_table(source, (), {"model_provider": PROVIDER})
    candidate = edit_table(candidate, ("model_providers", PROVIDER), {"base_url": active_url})
    candidate = edit_table(candidate, ("model_providers", PROVIDER, "capabilities"),
                           {"remote_compaction": "unsupported"})
    # Old routers also use the common conversion path when this marker is absent.
    if marker is not None:
        candidate = edit_table(candidate, ("model_providers", PROVIDER, "http_headers"),
                               {"x-codex-bridge-direct": None})
    return candidate


def verify_runtime(models, binary, port=8790):
    result = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=10, check=True)
    version = re.search(r"codex-cli (\d+)\.(\d+)\.(\d+)", result.stdout)
    if not version or tuple(map(int, version.groups())) < (0, 162, 0):
        raise ValueError("Codex 0.162.0以上で検証してください")
    health = verify_service(port)
    verify_service(8788)
    if health.get("mode") != "unified" or set(health.get("model_ids", [])) != {m["slug"] for m in models}:
        raise ValueError("同じ統合カタログで保護版routerを起動してください")


def configure(root, *, apply=False, restore=None, binary="codex"):
    source = private_read(root, "config.toml")
    models = read_catalog(root)
    if restore is not None:
        backup = Path(restore).absolute()
        if backup.parent != root or not backup.name.startswith(BACKUP_PREFIX):
            raise ValueError("このコマンドが同じ設定ディレクトリへ作ったバックアップを指定してください")
        target = private_read(root, backup.name)
        if source != candidate_config(target, root, models):
            raise ValueError("適用後に設定が変更されています。差分を確認して復元してください")
    else:
        target = candidate_config(source, root, models)
    changed = tomllib.loads(source) != tomllib.loads(target)
    report = {"mode": "apply" if apply else "preview", "action": "restore" if restore else "configure",
              "changed": changed, "existing_threads_modified": False, "service_restarted": False}
    if restore is None:
        report.update(target_provider=PROVIDER, compaction="local_plaintext", model_preserved=True)
    if not apply or not changed:
        return report
    if restore is None:
        url = tomllib.loads(target)["model_providers"][PROVIDER]["base_url"]
        verify_runtime(models, binary, 8791 if ":8791/" in url else 8790)
    if private_read(root, "config.toml") != source:
        raise ValueError("確認中に設定が変更されました。再実行してください")
    fd, backup_path = tempfile.mkstemp(prefix=BACKUP_PREFIX, dir=root)
    with os.fdopen(fd, "w") as output:
        output.write(source)
    if private_read(root, "config.toml") != source:
        raise ValueError("バックアップ中に設定が変更されました。適用していません")
    atomic_write(root / "config.toml", target)
    report["backup"] = backup_path
    return report


def main():
    parser = argparse.ArgumentParser(description="新しい統合チャットを文章要約へ揃えます。既定は変更なしのプレビュー。")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--restore", metavar="BACKUP")
    parser.add_argument("--codex", default="codex")
    args = parser.parse_args()
    root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser().absolute()
    try:
        report = configure(root, apply=args.apply, restore=args.restore, binary=args.codex)
    except (OSError, ValueError, subprocess.SubprocessError):
        # Configuration parsing and upstream failures can contain source text or credentials.
        raise SystemExit("設定を処理できませんでした。統合接続・権限・Codex版・競合を確認してください。認証情報は表示していません。") from None
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print("新規チャット向けの設定です。既存の暗号化履歴は自動移行しません。")


if __name__ == "__main__":
    main()
