import argparse
import json
import os
from pathlib import Path
import re
import sys
import tomllib
from urllib.request import urlopen

from switch_config import atomic_write
from local_security import SECURITY_VERSION


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
        cached_slug = model.get("slug")
        if isinstance(cached_slug, str) and cached_slug.startswith(("opencode/", "commandcode/", "ollama/", "auto-commandcode/", "auto-ollama/", "auto-whatstoken/")):
            # Dynamic discovery stores the combined list in Codex's shared cache.
            # Rebuild external routes from their own source, never as native GPT routes.
            # Provider model IDs may include an organization, e.g.
            # commandcode/moonshotai/Kimi-K3.1-Pro. Validate each component
            # before excluding external cache entries from the native catalog.
            for component in cached_slug.split("/")[1:]:
                checked_slug(component)
            continue
        slug = checked_slug(model.get("slug"))
        if slug.startswith("opencode/"):
            raise ValueError("OpenAIカタログにOpenCodeの名前空間が含まれています")
        safe = {**model, "slug": slug,
                "display_name": clean_text(model.get("display_name"), 120, slug),
                "router_provider": "openai", "router_model": slug}
        if "description" in safe:
            safe["description"] = clean_text(safe.get("description"), 500, "")
        models.append(safe)
    native_count = len(models)
    if not native_count:
        raise ValueError("OpenAIとOpenCode両方のモデルカタログが必要です")
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
    if len(models) == native_count or len({model["slug"] for model in models}) != len(models):
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
        if (root / "bridge-local-token").exists() and health.get("security") != SECURITY_VERSION:
            raise ValueError("保護版routerを起動してから有効にしてください")
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
    if path.is_symlink() or path.read_text() != source:
        raise ValueError("設定が変更されたかリンクです。再確認してください")
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


def update_transports(root):
    path = root / "unified-model-catalog.json"
    source = path.read_text()
    catalog = json.loads(source)
    for model in catalog["models"]:
        if model.get("router_provider") == "opencode":
            model["router_transport"] = "responses" if model.get("router_model") in DIRECT_RESPONSES_MODELS else "chat"
    candidate = json.dumps(catalog, ensure_ascii=False)
    if json.loads(source) == catalog:
        return
    if path.is_symlink() or path.read_text() != source:
        raise ValueError("カタログが変更されたかリンクです。再確認してください")
    import tempfile
    descriptor, backup_path = tempfile.mkstemp(prefix="unified-model-catalog.json.bak.transports.", dir=root)
    with os.fdopen(descriptor, "w") as backup:
        backup.write(source)
    atomic_write(path, candidate)
    print(f"カタログのバックアップ: {backup_path}")


def configure_flash_code_mode(catalog):
    model = next((model for model in catalog["models"] if model.get("slug") == "opencode/deepseek-v4.1-flash"), None)
    if not model or model.get("router_transport") != "responses":
        raise ValueError("公式Responses接続のFlashが必要です")
    model.update(tool_mode="code_mode_only", supports_search_tool=True, shell_type="unified_exec")


def activate_flash_code_mode(root):
    path = root / "unified-model-catalog.json"
    config = tomllib.loads((root / "config.toml").read_text())
    if (config.get("model_provider") != "codex-bridge"
            or config.get("model_catalog_json") != str(path)
            or config.get("model_providers", {}).get("codex-bridge", {}).get("http_headers", {}).get("x-codex-bridge-direct") != "1"):
        raise ValueError("先に通常codexの公式直接接続を有効にしてください")
    source = path.read_text()
    catalog = json.loads(source)
    configure_flash_code_mode(catalog)
    if catalog == json.loads(source):
        return
    if path.is_symlink() or path.read_text() != source:
        raise ValueError("カタログが変更されたかリンクです。再確認してください")
    import tempfile
    descriptor, backup_path = tempfile.mkstemp(prefix="unified-model-catalog.json.bak.flash-code-mode.", dir=root)
    with os.fdopen(descriptor, "w") as backup:
        backup.write(source)
    atomic_write(path, json.dumps(catalog, ensure_ascii=False))
    print(f"カタログのバックアップ: {backup_path}")
    print("Flashのツール設定3項目だけを更新しました。プロセスや既存会話は変更していません。")


def activate_normal(root, port):
    if not 1 <= port <= 65535:
        raise ValueError("ポートは1〜65535で指定してください")
    path = root / "config.toml"
    source = path.read_text()
    parsed = tomllib.loads(source)
    catalog = json.loads((root / "unified-model-catalog.json").read_text())
    model = next((model for model in catalog["models"] if model["slug"] == parsed.get("model")), None)
    if parsed.get("model_provider") not in (None, "openai", "codex-bridge"):
        raise ValueError("独自の既定providerは変更しません")
    if model and model.get("router_provider") == "openai":
        # GPTで開始する会話はnative providerを保つ。モデル名だけを変える/modelも
        # 同じrouterを通し、OpenCode側へは提供元に合わせて履歴を変換する。
        configure(root, "on", port)
        return
    if not model or model.get("router_provider") != "opencode":
        raise ValueError("通常起動の既定モデルが統合接続に対応していません。変更しません")
    provider = parsed.get("model_providers", {}).get("codex-bridge", {})
    if (provider.get("base_url") != f"http://127.0.0.1:{port}/v1" or provider.get("name") in (None, "OpenAI")
            or provider.get("requires_openai_auth") is not True or provider.get("wire_api") != "responses"
            or provider.get("http_headers", {}).get("x-codex-bridge-direct") not in (None, "1")):
        raise ValueError("標準local compactionを使う統合providerの設定を確認してください")
    with urlopen(f"http://127.0.0.1:{port}/health", timeout=3) as response:
        health = json.load(response)
    common_history = health.get("history_transport") == "chat"
    if common_history:
        if model["slug"] not in health.get("model_ids", []):
            raise ValueError("同じ統合カタログでrouterを起動してください")
    elif health.get("direct_header") != "x-codex-bridge-direct" or model["slug"] not in health.get("direct_models", []):
        raise ValueError("先に共通履歴対応routerを起動してください")
    candidate = edit_table(source, (), {"model_provider": "codex-bridge"})
    candidate = edit_table(candidate, ("model_providers", "codex-bridge", "http_headers"), {"x-codex-bridge-direct": None if common_history else "1"})
    if tomllib.loads(candidate) == parsed:
        return
    if path.is_symlink() or path.read_text() != source:
        raise ValueError("設定が変更されたかリンクです。再確認してください")
    import tempfile
    descriptor, backup_path = tempfile.mkstemp(prefix="config.toml.bak.normal-direct.", dir=root)
    with os.fdopen(descriptor, "w") as backup:
        backup.write(source)
    atomic_write(path, candidate, path.stat().st_mode & 0o777)
    print(f"バックアップ: {backup_path}")
    print("通常のcodex起動で統合接続を有効にしました。既存スレッドは変更していません。実行中のTUIは同じタブで再起動してください。")


def main():
    parser = argparse.ArgumentParser(description="同じチャットで双方向にモデルを切り替える設定")
    parser.add_argument("mode", choices=["prepare", "on", "off", "transports", "normal-on", "flash-code-mode"])
    parser.add_argument("--port", type=int, default=8790)
    arguments = parser.parse_args()
    root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser().resolve()
    if arguments.mode == "transports":
        update_transports(root)
        return
    elif arguments.mode == "flash-code-mode":
        activate_flash_code_mode(root)
        return
    elif arguments.mode == "normal-on":
        activate_normal(root, arguments.port)
        return
    elif arguments.mode == "prepare":
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
