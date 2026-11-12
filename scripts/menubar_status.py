"""メニューバーアプリ用の状態を、本文・鍵・パスを含まないJSONで1回だけ出力する（読み取り専用）。

- ルーター(既定8790)とブリッジ(既定8788)の /health を 127.0.0.1 へ問い合わせるだけ。待ち受けは開かない。
- 8791 など他のポートはルーターとして扱わない。
- 鍵ファイルは存在だけを見る。中身は開かない。
- ルーターの記録は直近の JSON 行から、提供元の件数と上限時の代行要約だけを数える。
"""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import subprocess
import time
from urllib.request import urlopen

ROUTER_LABEL = "com.kimurataiyou.codex-model-router"
HISTORY_MODES = ("selected", "openai", "ask")
KEY_FILES = {"commandcode": "commandcode-api-key", "ollama": "ollama-api-key"}
PROVIDERS = ("openai", "opencode", "commandcode", "ollama", "whatstoken")
HEX = re.compile(r"[0-9a-f]{12,64}\Z")
LOG_TAIL_BYTES = 1 << 20
LOG_REQUESTS = 200


def health(port, timeout):
    try:
        with urlopen(f"http://127.0.0.1:{port}/health", timeout=timeout) as response:
            if response.status != 200:
                return None
            value = json.loads(response.read(1 << 20))
            return value if isinstance(value, dict) and value.get("ok") is True else None
    except (OSError, ValueError):
        return None


def short_hex(value):
    return value[:12] if isinstance(value, str) and HEX.fullmatch(value) else None


def router_revision():
    """常駐登録が指す router-runtime/<revision> の名前だけを返す（読み取りのみ）。"""
    path = Path.home() / "Library/LaunchAgents" / (ROUTER_LABEL + ".plist")
    try:
        if path.is_symlink():
            return None
        arguments = plistlib.loads(path.read_bytes()).get("ProgramArguments", [])
        return short_hex(Path(arguments[1]).parent.name) if len(arguments) > 1 else None
    except (OSError, ValueError, IndexError, TypeError, plistlib.InvalidFileException):
        return None


def busy(port):
    """会話の接続があるか。lsofが使えなければ None（不明）。"""
    try:
        result = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:ESTABLISHED"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return {0: True, 1: False}.get(result.returncode)


def private_file(path):
    try:
        info = path.lstat()
    except OSError:
        return False
    return stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077


def history_mode(root):
    path = root / "bridge-history-mode.json"
    if not path.exists() and not path.is_symlink():
        return "selected"
    if not private_file(path):
        return "invalid"
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        return "invalid"
    if isinstance(value, dict) and value.get("version") == 1 and value.get("mode") in HISTORY_MODES:
        return value["mode"]
    return "invalid"


def provider_limits(root, now_ms):
    """提供元ごとの上限の解除時刻（ミリ秒）。理由や本文は返さない。"""
    path = root / "provider-fallback-state.json"
    if not private_file(path):
        return {}
    try:
        providers = json.loads(path.read_text()).get("providers", {})
    except (OSError, ValueError, AttributeError):
        return {}
    limits = {}
    for provider in PROVIDERS:
        windows = providers.get(provider, {}).get("windows", {}) if isinstance(providers, dict) else {}
        if not isinstance(windows, dict):
            continue
        until = [w.get("until") for w in windows.values() if isinstance(w, dict)]
        until = [u for u in until if isinstance(u, int) and not isinstance(u, bool) and u > now_ms]
        if until:
            limits[provider] = max(until)
    return limits


def log_summary(root):
    """直近の要求の提供元の内訳と、OpenAI上限で代わりに要約した回数。"""
    path = root / "log" / "model-router.log"
    counts, fallbacks, requests, last_fallback = {}, 0, 0, None
    try:
        if path.is_symlink():
            raise OSError
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - LOG_TAIL_BYTES))
            lines = handle.read().splitlines()
    except OSError:
        lines = []
    for raw in reversed(lines):
        if requests >= LOG_REQUESTS:
            break
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get("event") != "router_request":
            continue
        requests += 1
        provider = entry.get("provider")
        if provider in PROVIDERS:
            counts[provider] = counts.get(provider, 0) + 1
        if entry.get("remote_compaction_fallback") == "selected" and entry.get("remote_compaction_openai_status") == 429:
            fallbacks += 1
            if last_fallback is None:
                last_fallback = requests  # 何件前か（1 = 最新の要求）
    return {"requests": requests, "counts": counts, "openai_limit_fallbacks": fallbacks,
            "last_fallback_requests_ago": last_fallback}


def collect(root, router_port, bridge_port, timeout=1.5):
    now_ms = int(time.time() * 1000)
    router = health(router_port, timeout)
    if router is not None and router.get("mode") != "unified":
        router = None  # ルーターではない別のサーバー
    bridge = health(bridge_port, timeout)
    logs = log_summary(root)
    until = router.get("summary_limit_until") if router else None
    until = until if isinstance(until, int) and not isinstance(until, bool) and until > now_ms else None
    if until is not None:
        limit = {"openai_limited": True, "until": until, "source": "router"}
    elif router is not None and "summary_limit_until" in router:
        limit = {"openai_limited": False, "until": None, "source": "router"}
    else:
        # 古いルーターは解除時刻を返さない。記録から「最近あった」とだけ分かる。
        limit = {"openai_limited": None, "until": None, "source": "log"}
    limit["recent_fallbacks"] = logs["openai_limit_fallbacks"]
    limit["last_fallback_requests_ago"] = logs["last_fallback_requests_ago"]
    router_mode = router.get("history_mode") if router else None
    return {
        "version": 1,
        "checked_at": now_ms,
        "router": {
            "port": router_port, "running": router is not None,
            "implementation": short_hex(router.get("implementation")) if router else None,
            "revision": router_revision(),
            "history_mode": router_mode if router_mode in HISTORY_MODES else None,
            "busy": busy(router_port) if router is not None else False,
        },
        "bridge": {"port": bridge_port, "running": bridge is not None},
        "unified": {"enabled": (root / "unified-router-state.json").is_file()},
        "history_mode": history_mode(root),
        "summary_limit": limit,
        "providers": {"recent_requests": logs["requests"], "counts": logs["counts"],
                      "limited_until": provider_limits(root, now_ms)},
        "keys": {name: (root / file).is_file() for name, file in KEY_FILES.items()},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--router-port", type=int, default=8790)
    parser.add_argument("--bridge-port", type=int, default=8788)
    arguments = parser.parse_args()
    for port in (arguments.router_port, arguments.bridge_port):
        if not 1 <= port <= 65535:
            raise SystemExit("ポートは1〜65535で指定してください")
    root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser()
    print(json.dumps(collect(root, arguments.router_port, arguments.bridge_port), ensure_ascii=False))


if __name__ == "__main__":
    main()
