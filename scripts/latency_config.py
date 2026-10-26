"""Bound conversation growth without changing providers, models or tools."""
import argparse
import json
import os
from pathlib import Path
import tempfile
import tomllib

from switch_config import atomic_write
from unified_config import edit_table


DEFAULTS = {"model_auto_compact_token_limit": 128000,
            "model_auto_compact_token_limit_scope": "body_after_prefix"}


def configure(root, apply=False):
    path = root / "config.toml"
    if root.is_symlink() or path.is_symlink():
        raise ValueError("設定のシンボリックリンク先は変更しません")
    source = path.read_text()
    parsed = tomllib.loads(source)
    # An explicit threshold/scope remains the user's decision, including zero.
    values = {key: value for key, value in DEFAULTS.items() if key not in parsed}
    if not values:
        return {"changed": False, "applied": False, "settings": {key: parsed[key] for key in DEFAULTS}}
    candidate = edit_table(source, (), values)
    expected = {**parsed, **values}
    if tomllib.loads(candidate) != expected:
        raise ValueError("圧縮設定以外の変更を検出しました")
    result = {"changed": True, "applied": False, "settings": {key: expected[key] for key in DEFAULTS}}
    if apply:
        if path.is_symlink() or path.read_text() != source:
            raise ValueError("確認中に設定が変更されました。再実行してください")
        descriptor, backup = tempfile.mkstemp(prefix="config.toml.bak.latency.", dir=root)
        with os.fdopen(descriptor, "w") as output:
            output.write(source)
        atomic_write(path, candidate, path.stat().st_mode & 0o777)
        result.update(applied=True, backup=backup)
    return result


def main():
    parser = argparse.ArgumentParser(description="会話の成長分を128kで自動圧縮する。明示設定・モデル・接続先は保持する")
    parser.add_argument("--apply", action="store_true", help="既定は確認のみ。指定時だけ設定を保存する")
    args = parser.parse_args()
    root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser()
    print(json.dumps(configure(root, args.apply), ensure_ascii=False))


if __name__ == "__main__":
    main()
