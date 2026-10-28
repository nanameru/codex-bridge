"""Switch the local Codex client between static and authenticated live catalogs."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import tomllib
from urllib.request import urlopen

from switch_config import atomic_write
from unified_config import edit_table

PROVIDER = "codex-live"


@contextmanager
def exclusive_lock(path):
    """Block until this process owns path; works on POSIX and Windows."""
    with path.open("a+") as lock:
        if os.name == "nt":
            import msvcrt
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield


def candidate(source, port=8790):
    if not 1 <= port <= 65535:
        raise ValueError("ポートが不正です")
    data = tomllib.loads(source)
    current = data.get("model_providers", {}).get(PROVIDER)
    wanted = {"name": "OpenAI", "base_url": f"http://127.0.0.1:{port}/v1",
              "wire_api": "responses", "requires_openai_auth": True,
              "model_catalog_url": f"http://127.0.0.1:{port}/codex/models"}
    if current is not None and current != wanted:
        raise ValueError("codex-liveに独自設定があります。上書きしません")
    result = edit_table(source, (), {"model_catalog_json": None, "model_provider": PROVIDER})
    result = edit_table(result, ("model_providers", PROVIDER), wanted)
    parsed = tomllib.loads(result)
    if parsed.get("model_catalog_json") is not None:
        raise ValueError("model_catalog_jsonの削除に失敗しました")
    return result


def apply(root, port=8790, restore=False):
    config = root / "config.toml"
    state = root / "live-catalog-state.json"
    if any(p.is_symlink() for p in [root, config, state]):
        raise ValueError("リンクされた設定は変更しません")
    source = config.read_text()
    if restore:
        saved = json.loads(state.read_text())
        if source != saved["applied"]:
            raise ValueError("適用後に設定が変わっています。自動復元しません")
        atomic_write(config, saved["original"])
        state.unlink()
        return "restored"
    result = candidate(source, port)
    if result == source:
        return "unchanged"
    if state.exists():
        raise ValueError("前回の復元情報があります。先に確認してください")
    with urlopen(f"http://127.0.0.1:{port}/health", timeout=3) as response:
        health = json.load(response)
    if health.get("live_catalog") is not True:
        raise ValueError("動的カタログ対応のrouterを先に起動してください")
    # Keep an exact private backup; do not serialize the user's whole TOML anew.
    atomic_write(state, json.dumps({"original": source, "applied": result}, ensure_ascii=False))
    if config.read_text() != source:
        state.unlink()
        raise ValueError("設定が同時に変更されました")
    try:
        atomic_write(config, result)
    except Exception:
        state.unlink(missing_ok=True)
        raise
    return "applied"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--restore", action="store_true")
    parser.add_argument("--port", type=int, default=8790)
    args = parser.parse_args()
    root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    if args.restore and not args.apply:
        parser.error("復元には--applyも指定してください")
    with exclusive_lock(root / ".live-catalog.lock"):
        if args.apply:
            print(apply(root, args.port, args.restore))
            print("設定ファイルの更新と、起動済み常駐app-serverへの反映は別です。")
            print("他のチャットを止めずに読み込むには: codex resume <thread-id> --no-daemon")
            print("通常起動にも反映するには、全チャットの作業終了後に codex app-server daemon restart を実行してください。")
            print("このツールは常駐サーバーを停止しません。")
        else:
            candidate((root / "config.toml").read_text(), args.port)
            print("設定の検証が完了しました。適用は--apply、復元は--apply --restoreです")
