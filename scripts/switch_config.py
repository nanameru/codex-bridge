import fcntl
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from urllib.parse import urlsplit

try:
    import tomllib
except ImportError:
    raise SystemExit("Python 3.11 以上が必要です")


SELECTION_KEYS = ("model", "model_provider", "model_catalog_json")


def atomic_write(path, text, permissions=0o600):
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as output:
            os.fchmod(output.fileno(), permissions)
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def replace_selection(source, values):
    chunks = []
    pending = ""
    in_root = True
    inserted = False
    for line in source.splitlines(keepends=True):
        pending += line
        try:
            parsed = tomllib.loads(pending)
        except tomllib.TOMLDecodeError:
            continue
        if pending.lstrip().startswith("["):
            in_root = False
        if not inserted and not in_root:
            chunks.append(selection_text(values))
            inserted = True
        if not (in_root and any(key in parsed for key in SELECTION_KEYS)):
            chunks.append(pending)
        pending = ""
    if pending:
        raise ValueError("設定の構造を解析できません")
    if not inserted:
        chunks.append("\n" + selection_text(values))
    return "".join(chunks)


def selection_text(values):
    return "".join(f"{key} = {json.dumps(values[key], ensure_ascii=False)}\n"
                   for key in SELECTION_KEYS if key in values)


def selection(data):
    result = {key: data[key] for key in SELECTION_KEYS if key in data}
    if not all(isinstance(value, str) for value in result.values()):
        raise ValueError("モデル選択設定は文字列で指定してください")
    return result


def switch(mode, root):
    path = root / "config.toml"
    source = path.read_text()
    data = tomllib.loads(source)
    current = selection(data)
    state_path = root / "codex-bridge-switch-state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else None
    baseline = None
    candidate = source
    if mode == "on":
        if state is None and current.get("model_provider") != "codex-bridge":
            baseline = current
        model = os.environ.get("DEFAULT_MODEL", "deepseek-v4.1-flash")
        if (root / "unified-router-state.json").exists() and not model.startswith("opencode/"):
            model = "opencode/" + model
        candidate = replace_selection(source, {
            "model": model,
            "model_provider": "codex-bridge",
            "model_catalog_json": str(root / "model-catalog.json"),
        })
    elif mode == "off":
        restored = None
        if state is not None and current.get("model_provider") == "codex-bridge":
            restored = selection(state)
        elif current.get("model_provider") == "codex-bridge":
            backup = root / "config.toml.bak.switch"
            if backup.exists():
                previous = tomllib.loads(backup.read_text())
                if previous.get("model_provider") != "codex-bridge":
                    restored = selection(previous)
            if restored is None:
                restored = {}
                print("元の通常モデル設定がないため、Codex の既定モデルへ戻します")
        if restored is not None:
            candidate = replace_selection(source, restored)
    if "codex-bridge" not in data.get("model_providers", {}):
        port = int(os.environ.get("PORT", "8788"))
        if not 1 <= port <= 65535:
            raise ValueError("PORT は 1〜65535 で指定してください")
        candidate = candidate.rstrip() + (
            '\n\n[model_providers.codex-bridge]\n'
            'name = "Codex Bridge (OpenCode Go)"\n'
            f'base_url = "http://127.0.0.1:{port}/v1"\n'
            'wire_api = "responses"\n'
            'stream_idle_timeout_ms = 300000\n'
        )
    if (root / "unified-router-state.json").exists():
        from unified_config import edit_table, pin_realtime, write_state

        values = selection(tomllib.loads(candidate))
        values["model_catalog_json"] = str(root / "unified-model-catalog.json")
        candidate = replace_selection(candidate, values)
        # 一覧だけ統合してもnative providerの会話はChatGPTへ直送される。
        # on/off/repairのいずれでも両providerを同じrouterへ向ける。
        router_url = tomllib.loads(candidate)["model_providers"]["codex-bridge"]["base_url"]
        endpoint = urlsplit(router_url)
        if (endpoint.scheme != "http" or endpoint.hostname != "127.0.0.1" or not endpoint.port
                or endpoint.path != "/v1" or endpoint.username or endpoint.password
                or endpoint.query or endpoint.fragment):
            raise ValueError("統合routerのloopback接続定義を確認してください")
        unified_path = root / "unified-router-state.json"
        realtime, unified_state = pin_realtime(tomllib.loads(candidate), json.loads(unified_path.read_text()))
        candidate = edit_table(candidate, (), {"openai_base_url": router_url, **realtime})
    tomllib.loads(candidate)
    if (root / "unified-router-state.json").exists():
        write_state(unified_path, unified_state)
    if candidate != source:
        descriptor, backup_path = tempfile.mkstemp(prefix="config.toml.bak.switch.", dir=root)
        with os.fdopen(descriptor, "w") as backup:
            backup.write(source)
        if baseline is not None:
            atomic_write(state_path, json.dumps(baseline, ensure_ascii=False))
        atomic_write(path, candidate, stat.S_IMODE(path.stat().st_mode))
        print(f"バックアップ: {backup_path}")
    if mode == "off" and state_path.exists():
        state_path.unlink()
    print({"on": "→ ブリッジ経由", "off": "→ 通常モデルの設定", "repair": "→ 接続定義を保持・修復"}[mode])
    if (root / "unified-router-state.json").exists():
        print("統合routerでは同じチャットでも選択モデルに合わせて送信先を切り替えます。")
    else:
        print("変更対象は新規チャットの既定設定です。既存チャットの接続先は変わりません。")
    print("設定検証: OK。アプリや app-server の再起動は行っていません。")
    print("反映されない場合は、実行中の作業が完了してからアプリを開き直してください。")


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in {"on", "off", "repair"}:
        raise ValueError("使い方: switch.sh on|off|repair")
    root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser().resolve()
    if not (root / "config.toml").is_file():
        raise ValueError(f"config.toml が見つかりません: {root}")
    with (root / "codex-bridge-switch.lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        switch(sys.argv[1], root)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError) as error:
        raise SystemExit(f"設定を更新できません: {error}")
