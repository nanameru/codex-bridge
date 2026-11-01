"""Select the router's public shared catalog without replacing its upstream registry."""
import json
from pathlib import Path
import time
import tomllib

from switch_config import atomic_write, replace_selection


def select_common_models(root):
    path = root / "config.toml"
    if path.is_symlink() or (root / "shared-model-catalog.json").is_symlink():
        raise ValueError("リンクされたモデル設定は更新しません")
    source = path.read_text()
    config = tomllib.loads(source)
    public_path = root / "shared-model-catalog.json"
    catalog = json.loads(public_path.read_text())
    slugs = {model["slug"] for model in catalog["models"]}
    selected = config.get("model", "shared/deepseek-v4.1-flash")
    if selected not in slugs:
        # Preserve common old choices; removed provider-only choices use the default.
        raw = selected.split("/", 1)[-1].split("/")[-1].lower()
        selected = next((slug for slug in slugs if slug == "shared/" + raw), "shared/deepseek-v4.1-flash")
    if selected not in slugs:
        raise ValueError("共通モデルの既定値がありません。設定は変更していません")
    values = {"model": selected, "model_catalog_json": str(public_path)}
    if config.get("model_provider") is not None:
        values["model_provider"] = config["model_provider"]
    candidate = replace_selection(source, values)
    after = tomllib.loads(candidate)
    if any(after.get(key) != value for key, value in values.items()):
        raise ValueError("モデル設定の検証に失敗しました")
    if candidate != source:
        atomic_write(path.with_name(path.name + ".bak.common-models." + str(time.time_ns())), source)
        atomic_write(path, candidate, path.stat().st_mode & 0o777)
    return selected
