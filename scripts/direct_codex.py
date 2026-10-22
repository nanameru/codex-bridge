import argparse
import json
import os
from pathlib import Path
import tempfile
import tomllib

from switch_config import atomic_write
from unified_config import DIRECT_RESPONSES_MODELS, checked_slug, edit_table
from direct_launch import PROVIDER, api_key, run


BASE_URL = "https://opencode.ai/inference/go/openai/v1"


def configure(root):
    path = root / "config.toml"
    source = path.read_text()
    parsed = tomllib.loads(source)
    provider = {"name": "OpenCode Go", "base_url": BASE_URL, "env_key": "OPENCODE_API_KEY",
                "wire_api": "responses", "requires_openai_auth": False}
    catalog_path = root / "opencode-direct-model-catalog.json"
    launcher = root / "bin/codex-opencode"
    launcher_source = Path(__file__).with_name("direct_launch.py").read_text()
    if launcher.parent.is_symlink() or launcher.is_symlink() or (launcher.exists() and launcher.read_text() != launcher_source):
        raise ValueError("既存のcodex-opencodeコマンドは上書きしません")
    profile = {"model": "deepseek-v4.1-flash", "model_provider": PROVIDER,
               "model_catalog_json": str(catalog_path), "model_reasoning_effort": "low"}
    existing = parsed.get("model_providers", {}).get(PROVIDER)
    profile_path = root / (PROVIDER + ".config.toml")
    if ((existing is not None and existing != provider) or PROVIDER in parsed.get("profiles", {})
            or (profile_path.exists() and tomllib.loads(profile_path.read_text()) != profile)):
        raise ValueError("同名の独自設定があります。上書きしません")
    catalog = json.loads((root / "model-catalog.json").read_text())
    models = []
    for model in catalog["models"]:
        slug = checked_slug(model.get("slug"))
        if slug in DIRECT_RESPONSES_MODELS:
            models.append({key: value for key, value in model.items() if not key.startswith("router_")})
    if not any(model["slug"] == profile["model"] for model in models):
        raise ValueError("DeepSeek V4.1 Flashのモデル定義がありません")
    models.sort(key=lambda model: model["slug"] != profile["model"])
    candidate = edit_table(source, ("model_providers", PROVIDER), provider)
    if path.is_symlink() or catalog_path.is_symlink() or profile_path.is_symlink():
        raise ValueError("設定のシンボリックリンク先は変更しません")
    if path.read_text() != source:
        raise ValueError("確認中に設定が変更されました。再実行してください")
    launcher.parent.mkdir(exist_ok=True, mode=0o700)
    atomic_write(launcher, launcher_source, 0o700)
    atomic_write(catalog_path, json.dumps({"models": models}, ensure_ascii=False))
    atomic_write(profile_path, edit_table("", (), profile))
    if tomllib.loads(candidate) != parsed:
        descriptor, backup = tempfile.mkstemp(prefix="config.toml.bak.direct.", dir=root)
        with os.fdopen(descriptor, "w") as output:
            output.write(source)
        atomic_write(path, candidate, path.stat().st_mode & 0o777)
    return len(models)


def main():
    parser = argparse.ArgumentParser(description="公式APIキーでCodexをOpenCode Goへ直接接続する")
    parser.add_argument("mode", choices=["configure", "run"])
    arguments, extra = parser.parse_known_args()
    root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser().resolve()
    if arguments.mode == "configure":
        if extra:
            parser.error("configureに追加引数は指定できません")
        count = configure(root)
        print(f"公式接続プロフィールを設定しました（{count}モデル）。既存チャット・既定モデル・routerは変更していません。")
        return
    raise SystemExit(run(extra))


if __name__ == "__main__":
    main()
