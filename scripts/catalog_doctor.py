"""Diagnose and migrate a static OpenCode-only model_catalog_json (Issue #143).

Reads only config.toml, the referenced catalog and models_cache.json.
Never reads auth.json or prints provider settings that may carry secrets.
"""
import sys

if sys.version_info < (3, 11):
    sys.exit("Python 3.11以上が必要です（現在: %d.%d）" % sys.version_info[:2])

import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import tomllib
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
from live_catalog import PROVIDER, candidate, exclusive_lock

TARGET_MODEL = "gpt-6.1-sol"
STATE = "catalog-migration-state.json"
FOREIGN_STATES = ("live-catalog-state.json", "unified-router-state.json")


def slugs(document):
    models = document.get("models") if isinstance(document, dict) else None
    if not isinstance(models, list):
        raise ValueError("modelsが配列ではありません")
    found = [m.get("slug") for m in models if isinstance(m, dict)]
    if not found or not all(isinstance(s, str) and s for s in found):
        raise ValueError("slugが不正な項目があります")
    return found


def is_native(slug, official=None):
    """Namespaced slugs are external; with an official list, only listed slugs count as native."""
    return "/" not in slug and (official is None or slug in official)


def read_config(root):
    config = root / "config.toml"
    if any(p.is_symlink() for p in [root, config]):
        raise ValueError("リンクされた設定は扱いません")
    raw = config.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raise ValueError("config.tomlがBOM付きです。自動変更しません")
    text = raw.decode("utf-8")
    newline = "\r\n" if "\r\n" in text else "\n"
    return raw, text.replace("\r\n", "\n"), newline


def load_json(path):
    if path.is_symlink():
        raise ValueError(f"リンクされたファイルは扱いません: {path.name}")
    return json.loads(path.read_text(encoding="utf-8"))


def official_cache(root):
    path = root / "models_cache.json"
    if not path.is_file():
        return None
    try:
        return [s for s in slugs(load_json(path)) if is_native(s)]
    except (OSError, ValueError):
        return None


def target_verdict(listed, official, target):
    if target in listed:
        return "listed", "一覧にあります。実プランで使えるかは一覧では判定できないため、実際の1回の送信で確認してください"
    if official is None:
        return "unknown_no_cache", "公式一覧のキャッシュが無く、カタログ欠落かプラン未提供か判定できません"
    if target in official:
        return "hidden_by_catalog", "公式一覧には提供されていますが、model_catalog_jsonの置換で一覧から消えています"
    return "not_in_official_list", "公式一覧のキャッシュにもありません。プラン/アカウント未提供か、キャッシュが古い可能性があります"


def diagnose(root, target=TARGET_MODEL):
    _, text, _ = read_config(root)
    data = tomllib.loads(text)
    official = official_cache(root)
    report = {"model": data.get("model"), "model_provider": data.get("model_provider"),
              "catalog_path": None, "native_count": None, "external_count": None,
              "official_cache_native_count": None if official is None else len(official)}
    catalog = data.get("model_catalog_json")
    if catalog is None:
        status = "dynamic" if data.get("model_provider") == PROVIDER else "builtin"
        listed = official or []
    elif not isinstance(catalog, str):
        status, listed = "unknown", []
    else:
        report["catalog_path"] = catalog
        path = Path(catalog).expanduser()
        if not path.is_absolute():
            path = root / path
        try:
            listed = slugs(load_json(path))
        except (OSError, ValueError) as error:
            report["catalog_error"] = type(error).__name__
            status, listed = "unknown", []
        else:
            native = [s for s in listed if is_native(s, official)]
            report["native_count"], report["external_count"] = len(native), len(listed) - len(native)
            status = "legacy_opencode_only" if not native else ("unified" if len(native) < len(listed) else "native_only")
    if status == "unknown":
        verdict = ("unknown", "カタログを読めないため判定できません")
    elif status == "builtin" and not official:
        verdict = target_verdict([], official, target)
    else:
        verdict = target_verdict(listed, official, target)
    report.update(status=status, target=target, target_status=verdict[0], target_message=verdict[1])
    return report


def write_exact(path, data, exclusive=False):
    if exclusive:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        return
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def home_id(root):
    """Matches codexHomeId() in src/local-security.mjs without reading any credential."""
    path = os.path.realpath(root)
    return hashlib.sha256((path.lower() if os.name == "nt" else path).encode("utf-8")).hexdigest()


def router_problem(port, root):
    """Return why codex-live would list no models, or None when the router can serve this CODEX_HOME."""
    try:
        with urlopen(f"http://127.0.0.1:{port}/health", timeout=3) as response:
            health = json.load(response)
    except (OSError, ValueError):
        return "routerに接続できません。動的カタログ対応のrouterを先に起動してください"
    if not isinstance(health, dict) or health.get("live_catalog") is not True:
        return "routerが動的カタログに対応していません"
    auth = health.get("catalog_auth")
    if not isinstance(auth, dict):
        return "routerが認証状態を報告しません。routerを最新版に更新してください"
    if auth.get("codex_home") != home_id(root):
        return "routerが別のCODEX_HOMEを使っています。移行後の一覧が0件になるため変更しません"
    if auth.get("ready") is not True:
        return "routerがCodexの認証を確認できません（node src/auth-doctor.mjs で診断）。移行後の一覧が0件になるため変更しません"
    return None


def restore(root):
    config, state_path = root / "config.toml", root / STATE
    if state_path.is_symlink() or not state_path.is_file():
        raise ValueError("移行の記録がありません。復元しません")
    state = json.loads(state_path.read_text(encoding="utf-8"))
    backup = root / state["backup"]
    if digest(config.read_bytes()) != state["applied_sha256"]:
        raise ValueError("移行後にconfig.tomlが変わっています。自動復元しません")
    original = backup.read_bytes()
    if backup.is_symlink() or digest(original) != state["original_sha256"]:
        raise ValueError("バックアップが記録と一致しません。自動復元しません")
    write_exact(config, original)
    state_path.unlink()
    return "restored"


def migrate(root, port=8790, ready=router_problem):
    config, state_path = root / "config.toml", root / STATE
    raw, text, newline = read_config(root)
    report = diagnose(root)
    if state_path.exists() or state_path.is_symlink():
        state = json.loads(state_path.read_text(encoding="utf-8"))
        if digest(raw) == state.get("applied_sha256"):
            return "unchanged"
        raise ValueError("前回の移行記録と現在の設定が一致しません。上書きしません")
    for name in FOREIGN_STATES:
        if (root / name).exists():
            raise ValueError(f"{name}が残っています。先に確認してください")
    if report["status"] == "dynamic":
        return "unchanged"
    if report["status"] != "legacy_opencode_only":
        raise ValueError(f"移行対象ではありません（状態: {report['status']}）。変更しません")
    result = candidate(text, port)
    applied = result.replace("\n", newline).encode("utf-8")
    problem = ready(port, root)
    if problem:
        raise ValueError(problem)
    backup = root / f"config.toml.issue143-{time.strftime('%Y%m%d%H%M%S')}.bak"
    write_exact(backup, raw, exclusive=True)
    state = {"backup": backup.name, "original_sha256": digest(raw), "applied_sha256": digest(applied)}
    write_exact(state_path, json.dumps(state, ensure_ascii=False).encode("utf-8"), exclusive=True)
    try:
        if config.read_bytes() != raw:
            raise ValueError("設定が同時に変更されました")
        write_exact(config, applied)
    except Exception:
        state_path.unlink(missing_ok=True)
        raise
    return "applied"


def show(report):
    labels = {"legacy_opencode_only": "旧OpenCode専用カタログが組み込み一覧を置換しています（Issue #143）",
              "unified": "公式モデルとOpenCodeを含む固定カタログです", "native_only": "公式モデルだけの固定カタログです",
              "builtin": "固定カタログはありません（組み込み一覧）", "dynamic": f"{PROVIDER}の動的カタログを使っています",
              "unknown": "状態を判定できません。自動変更しません"}
    print(f"状態: {report['status']} — {labels[report['status']]}")
    print(f"既定モデル: {report['model']} / provider: {report['model_provider']}")
    if report["catalog_path"]:
        print(f"model_catalog_json: {report['catalog_path']}（公式 {report['native_count']} 件 / 外部 {report['external_count']} 件）")
    print(f"公式一覧キャッシュ: {report['official_cache_native_count']} 件")
    print(f"{report['target']}: {report['target_status']} — {report['target_message']}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Issue #143 カタログ診断・移行")
    parser.add_argument("action", nargs="?", default="diagnose", choices=["diagnose", "apply", "restore"])
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser()
    if args.action == "diagnose":
        report = diagnose(root)
        print(json.dumps(report, ensure_ascii=False)) if args.json else show(report)
        return 0
    with exclusive_lock(root / ".catalog-doctor.lock"):
        print(restore(root) if args.action == "restore" else migrate(root, args.port))
        print("Codexデスクトップ/CLIを全て終了して再起動すると一覧に反映されます。このツールはプロセスを停止しません。")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, tomllib.TOMLDecodeError) as error:
        sys.exit(f"変更しませんでした: {error}")
