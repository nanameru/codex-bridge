import argparse
import json
import os
from pathlib import Path
import re
import sys
import tomllib
from urllib.request import urlopen

from switch_config import atomic_write


ROOT_KEYS = ("openai_base_url", "model_catalog_json")
BRIDGE_KEYS = ("base_url", "requires_openai_auth", "wire_api")
BRIDGE_TABLE = ("model_providers", "codex-bridge")
PINNED_MODELS = ("opencode/deepseek-v4.1-flash", "gpt-6.1-sol")
DIRECT_RESPONSES_MODELS = frozenset(("deepseek-v4.1-flash", "deepseek-v4-pro", "gpt-6-luna",
                                   "gpt-5.6-luna", "grok-4.7", "muse-spark-1.2-contributor",
                                   "muse-spark-1.3-contributor"))
ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])")
UNSAFE_TEXT = re.compile(r"[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]")
MODEL_SLUG = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


def clean_text(value, limit, fallback):
    if not isinstance(value, str):
        return fallback
    text = UNSAFE_TEXT.sub(" ", ANSI.sub("", value))
    text = " ".join(text.split())[:limit]
    return text or fallback


def checked_slug(value):
    if not isinstance(value, str) or not MODEL_SLUG.fullmatch(value):
        raise ValueError("モデルIDが不正です")
    return value


def prioritize(models):
    order = {slug: index for index, slug in enumerate(PINNED_MODELS)}
    indexed = list(enumerate(models))
    indexed.sort(key=lambda item: (0, order[item[1]["slug"]]) if item[1]["slug"] in order
                 else (1, item[0]))
    next_priority = 2 if any(model["slug"] in order for model in models) else 1
    result = []
    for _index, model in indexed:
        if model["slug"] in order:
            result.append({**model, "priority": 1})
        else:
            result.append({**model, "priority": next_priority})
            next_priority += 1
    return result


def statements(source):
    pending = ""
    for line in source.splitlines(keepends=True):
        pending += line
        try:
            parsed = tomllib.loads(pending)
        except tomllib.TOMLDecodeError:
            continue
        yield pending, parsed
        pending = ""
    if pending:
        raise ValueError("設定の構造を解析できません")


def table_path(parsed):
    path = []
    while isinstance(parsed, dict) and len(parsed) == 1:
        name, parsed = next(iter(parsed.items()))
        path.append(name)
    return tuple(path)


def edit_table(source, target, values):
    tomllib.loads(source)
    current = ()
    pending = dict(values)
    output = []
    found = target == ()

    def flush():
        if pending:
            prefix = "" if not output or output[-1].endswith("\n") else "\n"
            output.append(prefix + "".join(f"{key} = {json.dumps(value, ensure_ascii=False)}\n"
                                          for key, value in pending.items() if value is not None))
            pending.clear()

    for statement, parsed in statements(source):
        if statement.lstrip().startswith("["):
            if current == target:
                flush()
            current = table_path(parsed)
            if current == target:
                found = True
        elif current == target and any(key in parsed for key in values):
            continue
        output.append(statement)
    if not found:
        output.append("\n[" + ".".join(json.dumps(part) for part in target) + "]\n")
    flush()
    result = "".join(output)
    tomllib.loads(result)
    return result


def prepare(root, source_root):
    native = json.loads((root / "models_cache.json").read_text())["models"]
    opencode = json.loads((root / "model-catalog.json").read_text())["models"]
    source_models = json.loads((source_root / "src/models.json").read_text())["models"]
    if not all(isinstance(model, dict) for model in source_models):
        raise ValueError("モデルIDが不正です")
    allowed = {checked_slug(model.get("id")) for model in source_models}
    if (not isinstance(native, list) or not isinstance(opencode, list)
            or len(native) > 500 or len(opencode) > 500):
        raise ValueError("モデルカタログの件数が不正です")
    if not native or not opencode:
        raise ValueError("OpenAIとOpenCode両方のモデルカタログが必要です")
    models = []
    for model in native:
        if not isinstance(model, dict):
            raise ValueError("モデルカタログの形式が不正です")
        slug = checked_slug(model.get("slug"))
        if slug.startswith("opencode/"):
            raise ValueError("OpenAIカタログにOpenCodeの名前空間が含まれています")
        safe = {**model, "slug": slug,
                "display_name": clean_text(model.get("display_name"), 120, slug),
                "router_provider": "openai", "router_model": slug}
        if "description" in safe:
            safe["description"] = clean_text(safe.get("description"), 500, "")
        models.append(safe)
    for model in opencode:
        if not isinstance(model, dict):
            raise ValueError("モデルカタログの形式が不正です")
        slug = checked_slug(model.get("slug"))
        if slug not in allowed:
            continue
        name = clean_text(model.get("display_name"), 120, slug)
        safe = {**model, "slug": "opencode/" + slug,
                "display_name": "OpenCode · " + name,
                "router_provider": "opencode", "router_model": slug,
                "router_transport": "responses" if slug in DIRECT_RESPONSES_MODELS else "chat"}
        if "description" in safe:
            safe["description"] = clean_text(safe.get("description"), 500, "")
        models.append(safe)
    models = prioritize(models)
    if len(models) == len(native) or len({model["slug"] for model in models}) != len(models):
        raise ValueError("統合カタログにモデルがないか、名前が重複しています")
    path = root / "unified-model-catalog.json"
    atomic_write(path, json.dumps({"models": models}, ensure_ascii=False))
    return path


def configure(root, mode, port):
    if not 1 <= port <= 65535:
        raise ValueError("ポートは1〜65535で指定してください")
    path = root / "config.toml"
    state_path = root / "unified-router-state.json"
    source = path.read_text()
    data = tomllib.loads(source)
    bridge = data.get("model_providers", {}).get("codex-bridge", {})
    if mode == "on":
        if any(bridge.get(key) for key in ["env_key", "auth", "experimental_bearer_token"]):
            raise ValueError("codex-bridgeに独自認証があります。自動では変更しません")
        catalog = root / "unified-model-catalog.json"
        model_ids = {model["slug"] for model in json.loads(catalog.read_text())["models"]}
        with urlopen(f"http://127.0.0.1:{port}/health", timeout=3) as response:
            health = json.load(response)
        if health.get("mode") != "unified" or set(health.get("model_ids", [])) != model_ids:
            raise ValueError("同じ統合カタログでrouterを起動してから有効にしてください")
        state = json.loads(state_path.read_text()) if state_path.exists() else {
            "root": {key: data.get(key) for key in ROOT_KEYS},
            "bridge": {key: bridge.get(key) for key in BRIDGE_KEYS},
            "bridge_existed": bool(bridge),
        }
        candidate = edit_table(source, (), {
            "openai_base_url": f"http://127.0.0.1:{port}/v1", "model_catalog_json": str(catalog),
        })
        changes = {"base_url": f"http://127.0.0.1:{port}/v1", "requires_openai_auth": True, "wire_api": "responses"}
        if not bridge:
            changes["name"] = "Codex Bridge (Unified)"
        candidate = edit_table(candidate, BRIDGE_TABLE, changes)
    else:
        if not state_path.exists():
            print("統合ルーティングは無効です")
            return
        state = json.loads(state_path.read_text())
        candidate = edit_table(source, (), state["root"])
        changes = state["bridge"] if state["bridge_existed"] else {
            "base_url": "http://127.0.0.1:8788/v1", "requires_openai_auth": None, "wire_api": "responses",
        }
        candidate = edit_table(candidate, BRIDGE_TABLE, changes)
    if candidate != source:
        import tempfile
        descriptor, backup_path = tempfile.mkstemp(prefix="config.toml.bak.unified.", dir=root)
        with os.fdopen(descriptor, "w") as backup:
            backup.write(source)
        if mode == "on" and not state_path.exists():
            atomic_write(state_path, json.dumps(state, ensure_ascii=False))
        atomic_write(path, candidate, path.stat().st_mode & 0o777)
        print(f"バックアップ: {backup_path}")
    if mode == "off":
        switch_state = root / "codex-bridge-switch-state.json"
        if switch_state.exists():
            saved = json.loads(switch_state.read_text())
            if saved.get("model_catalog_json") == str(root / "unified-model-catalog.json"):
                if state["root"]["model_catalog_json"] is None:
                    saved.pop("model_catalog_json", None)
                else:
                    saved["model_catalog_json"] = state["root"]["model_catalog_json"]
                atomic_write(switch_state, json.dumps(saved, ensure_ascii=False))
        state_path.unlink()
    print("統合ルーティング: " + mode)
    print("既存アプリや実行中の処理は再起動しません。開いているチャットは完了後に開き直してください。")


def main():
    parser = argparse.ArgumentParser(description="同じチャットで双方向にモデルを切り替える設定")
    parser.add_argument("mode", choices=["prepare", "on", "off"])
    parser.add_argument("--port", type=int, default=8790)
    arguments = parser.parse_args()
    root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser().resolve()
    if arguments.mode == "prepare":
        print(prepare(root, Path(__file__).resolve().parents[1]))
        return
    import fcntl
    with (root / "codex-bridge-switch.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        configure(root, arguments.mode, arguments.port)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise SystemExit(f"統合設定を変更できません: {error}")
