"""Owner-aware handling of Codex's Realtime voice WebSocket URL (Issue #145).

Codex sends voice to `experimental_realtime_ws_base_url`, or, when it is unset,
to the selected provider's base URL. Pointing `openai_base_url` at the text
router therefore also moves voice to a router that rejects WebSocket upgrades.
"""
import argparse
import http.client
import json
import os
from pathlib import Path
import tomllib
from urllib.parse import urlsplit

KEY = "experimental_realtime_ws_base_url"
OFFICIAL_URL = "wss://api.openai.com/v1"
OFFICIAL_HOST = "api.openai.com"
OPENAI_DEFAULT_BASE = "https://api.openai.com/v1"
BRIDGE_PORTS = frozenset((8788, 8790, 8791))
KEEP_ENV = "CODEX_BRIDGE_KEEP_REALTIME_OVERRIDE"
LOOPBACK_HOSTS = frozenset(("localhost", "::1", "0.0.0.0"))

REPAIR_STEPS = (
    "音声(Realtime)の接続先が他ツールのローカルproxyを指しています。Bridgeは上書きしません。\n"
    "  1. 状態確認: python3 scripts/realtime_config.py doctor\n"
    "  2. そのproxyを導入したツール(例: opencodex)のCodex統合を無効にするか、"
    f"config.tomlの {KEY} 行を削除してください\n"
    "  3. そのproxyがRealtimeを実装していると確認済みで残す場合だけ、"
    f"{KEEP_ENV}=1 を付けて再実行してください"
)


def snapshot(data):
    """Distinguish unset from empty string and from an existing value."""
    if KEY not in data:
        return {"present": False, "value": None}
    return {"present": True, "value": data[KEY]}


def is_loopback(host):
    host = (host or "").lower()
    return host in LOOPBACK_HOSTS or host.startswith("127.")


def safe_url(value):
    """Display form without credentials, query or fragment."""
    if not isinstance(value, str):
        return value
    try:
        parts = urlsplit(value)
        host = parts.hostname or ""
        port = f":{parts.port}" if parts.port else ""
    except ValueError:
        return "<解析不能なURL>"
    if not parts.scheme:
        return "<解析不能なURL>"
    return f"{parts.scheme}://{host}{port}{parts.path}"


def classify(value, present=True, bridge_value=None):
    """Return unset / empty / invalid / official / bridge / bridge-router / loopback-foreign / remote."""
    if not present:
        return "unset"
    if not isinstance(value, str):
        return "invalid"
    if value == "":
        return "empty"
    if bridge_value is not None and value == bridge_value:
        return "bridge"
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        return "invalid"
    if parts.scheme not in ("ws", "wss", "http", "https") or not parts.hostname:
        return "invalid"
    if parts.hostname.lower() == OFFICIAL_HOST and parts.scheme in ("wss", "https") and port in (None, 443):
        return "official"
    if is_loopback(parts.hostname):
        return "bridge-router" if port in BRIDGE_PORTS else "loopback-foreign"
    return "remote"


def plan(data, state_entry, environ=None):
    """Decide the Realtime value while Bridge routes text through its router.

    Returns (changes for edit_table, state entry, warnings). Raises ValueError
    without side effects when the existing value belongs to another tool.
    """
    environ = os.environ if environ is None else environ
    current = snapshot(data)
    bridge_value = state_entry.get("bridge_value") if state_entry and state_entry.get("owner") == "bridge" else None
    kind = classify(current["value"], current["present"], bridge_value)
    warnings = []
    if kind == "unset":
        # A rerun after an interrupted write keeps the first snapshot Bridge took.
        original = state_entry["original"] if bridge_value is not None else current
        return {KEY: OFFICIAL_URL}, {"original": original, "owner": "bridge", "bridge_value": OFFICIAL_URL}, warnings
    if kind == "bridge":
        # Rewriting the same value keeps key order stable across reruns.
        return {KEY: bridge_value}, state_entry, warnings
    entry = {"original": current, "owner": "user", "bridge_value": None}
    if kind == "official":
        return {}, entry, warnings
    if kind == "remote":
        warnings.append(f"Realtime接続先 {safe_url(current['value'])} は本人設定として保持します")
        return {}, entry, warnings
    keep = environ.get(KEEP_ENV) == "1"
    if kind == "loopback-foreign" and keep:
        warnings.append(f"{KEEP_ENV}=1 のためRealtime接続先 {safe_url(current['value'])} を保持します。音声が"
                        "Reconnectingになる場合はそのproxyのRealtime対応を確認してください")
        return {}, entry, warnings
    if kind == "loopback-foreign":
        raise ValueError(f"{KEY}={safe_url(current['value'])}\n" + REPAIR_STEPS)
    if kind == "bridge-router":
        raise ValueError(f"{KEY}={safe_url(current['value'])} はBridgeのテキストrouterを指しています。"
                         "routerはRealtimeを実装していないため音声が接続できません。"
                         f"config.tomlの {KEY} 行を削除してから再実行してください")
    raise ValueError(f"{KEY} が空または不正です({kind})。Codexは音声接続先を組み立てられません。"
                     f"config.tomlの {KEY} 行を削除してから再実行してください")


def restore(data, state_entry):
    """Undo only what Bridge wrote. Returns (changes, warnings); idempotent."""
    if not state_entry or state_entry.get("owner") != "bridge":
        return {}, []
    current = snapshot(data)
    original = state_entry["original"]
    if current == original:
        return {}, []
    if current != {"present": True, "value": state_entry.get("bridge_value")}:
        return {}, [f"Realtime接続先はBridge有効化後に変更されたため保持します: {safe_url(current['value'])}"]
    return {KEY: original["value"] if original["present"] else None}, []


def provider_base(data):
    provider_id = data.get("model_provider") or "openai"
    if provider_id == "openai":
        base = data.get("openai_base_url") or None
        return provider_id, base or OPENAI_DEFAULT_BASE
    provider = data.get("model_providers", {}).get(provider_id, {})
    return provider_id, provider.get("base_url") or OPENAI_DEFAULT_BASE


def websocket_target(base):
    """Mirror Codex's ws URL derivation (scheme swap, default /v1/realtime path)."""
    parts = urlsplit(base)
    scheme = {"http": "ws", "https": "wss"}.get(parts.scheme, parts.scheme)
    path = parts.path.rstrip("/")
    if not path:
        path = "/v1/realtime"
    elif not path.endswith("/realtime"):
        path += "/realtime"
    port = f":{parts.port}" if parts.port else ""
    return f"{scheme}://{parts.hostname}{port}{path}"


def probe(target, timeout=3):
    """Unauthenticated WebSocket handshake to a loopback target; never sends audio."""
    parts = urlsplit(target)
    if not is_loopback(parts.hostname) or parts.scheme != "ws":
        return None
    connection = http.client.HTTPConnection(parts.hostname, parts.port or 80, timeout=timeout)
    try:
        connection.request("GET", parts.path, headers={
            "Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": "Y29kZXgtYnJpZGdlLTE0NQ==",
        })
        return connection.getresponse().status
    except OSError:
        return 0
    finally:
        connection.close()


def diagnose(root, with_probe=False):
    data = tomllib.loads((root / "config.toml").read_text(encoding="utf-8"))
    state_path = root / "unified-router-state.json"
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else None
    entry = (state or {}).get("realtime")
    current = snapshot(data)
    bridge_value = entry.get("bridge_value") if entry and entry.get("owner") == "bridge" else None
    kind = classify(current["value"], current["present"], bridge_value)
    provider_id, text_base = provider_base(data)
    if kind == "unset":
        effective = text_base
    elif kind in ("empty", "invalid"):
        effective = None
    else:
        effective = current["value"]
    target = websocket_target(effective) if effective else None
    problems = []
    if kind in ("empty", "invalid"):
        problems.append("Realtime設定が空または不正で、音声接続先を組み立てられません")
    elif kind == "unset" and target and is_loopback(urlsplit(target).hostname):
        problems.append("Realtime未設定のため、音声がテキスト用のローカル接続先へ送られます")
    elif kind in ("loopback-foreign", "bridge-router"):
        problems.append("Realtime接続先がローカルproxyです。proxyがRealtimeを実装していなければ接続できません")
    if state is not None and entry is None:
        problems.append("統合routerのstateにRealtimeの記録がありません。scripts/switch.sh repairで記録してください")
    status = probe(target) if with_probe and target else None
    if status is not None and status != 101:
        problems.append(f"ローカル接続先がWebSocket接続を拒否しました(HTTP {status or '接続不可'})")
    return {
        "ok": not problems,
        "model_provider": provider_id,
        "text_base_url": safe_url(text_base),
        "realtime_setting": {"state": kind, "value": safe_url(current["value"])},
        "realtime_target": safe_url(target) if target else None,
        "unified_router": state is not None,
        "bridge_owns_realtime": bool(bridge_value),
        "probe_status": status,
        "problems": problems,
    }


def main():
    parser = argparse.ArgumentParser(description="Realtime音声接続先の診断(設定は変更しません)")
    parser.add_argument("mode", choices=["doctor"])
    parser.add_argument("--probe", action="store_true",
                        help="ローカル接続先にだけ認証なしのWebSocket handshakeを送る")
    arguments = parser.parse_args()
    root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser().resolve()
    result = diagnose(root, arguments.probe)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise SystemExit(f"Realtime設定を診断できません: {error}")
