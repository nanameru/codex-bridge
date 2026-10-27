"""Safe local service operations. No inference, credential printing, or conversation edits."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import time
import tomllib

from install_router_service import replace_registration, wait_for_idle
from local_security import ensure_bridge_key, private_read, verify_service
import patch_legacy_security
from switch_config import atomic_write

ROOT = Path(__file__).resolve().parents[1]
LEGACY_LABEL = "com.kimurataiyou.codex-bridge"


def check_credentials(root):
    # Share the exact runtime resolver, including macOS Keychain. Never copy tokens.
    result = subprocess.run(["node", str(ROOT / "src/auth-doctor.mjs"), "--root", str(root)],
                            text=True, capture_output=True, timeout=10)
    if result.returncode != 0:
        raise ValueError("本人のCodex認証を確認できません。node src/auth-doctor.mjsで診断してください")


def check_opencode_credentials():
    auth = json.loads(private_read(Path.home() / ".local/share/opencode", "auth.json")).get("opencode-go", {})
    if auth.get("type") != "api" or not auth.get("key"):
        raise ValueError("安全な権限で保存されたOpenCode Go APIキーが必要です")


def doctor(root):
    checks = {}
    for name, check in [
        ("owner_credentials", lambda: check_credentials(root)),
        ("opencode_api_credentials", check_opencode_credentials),
        ("private_bridge_key", lambda: ensure_existing_key(root)),
        ("router_protected", lambda: verify_service(8790)),
        ("bridge_protected_dump_off", lambda: verify_service(8788)),
        ("routing_config", lambda: check_config(root)),
    ]:
        try:
            check()
            checks[name] = True
        except (OSError, ValueError, KeyError, TypeError):
            checks[name] = False
    print(json.dumps({"ok": all(checks.values()), "checks": checks,
                      "history_sent_to_selected_provider": True}, ensure_ascii=False))
    return all(checks.values())


def ensure_existing_key(root):
    import re
    if not re.fullmatch(r"[a-f0-9]{64}", private_read(root, "bridge-local-token").strip()):
        raise ValueError("内部鍵が不正です")


def check_config(root):
    config = tomllib.loads(private_read(root, "config.toml"))
    base = "http://127.0.0.1:8790/v1"
    if (config.get("openai_base_url") != base
            or config.get("model_providers", {}).get("codex-bridge", {}).get("base_url") != base
            or config.get("model_catalog_json") != str(root / "unified-model-catalog.json")):
        raise ValueError("統合接続の設定が一致しません")


def wait_legacy_health(revision):
    for _attempt in range(30):
        try:
            verify_service(8788, revision)
            return
        except (OSError, ValueError):
            time.sleep(0.2)
    raise ValueError("旧ブリッジ更新後の保護状態を確認できません")


def apply(root, target, wait_seconds):
    if sys.platform != "darwin":
        raise ValueError("サービス反映はmacOS専用です。他OSの手順は運用文書を参照してください")
    check_credentials(root)
    check_opencode_credentials()
    check_config(root)
    source, updated, module, helper = patch_legacy_security.prepare(target)
    module_before = module.read_bytes() if module.exists() else None
    manifest = module.with_name(".local-security.sha256")
    manifest_before = manifest.read_bytes() if manifest.exists() else None
    path = Path.home() / "Library/LaunchAgents" / (LEGACY_LABEL + ".plist")
    if path.is_symlink():
        raise ValueError("リンクされたサービス定義は更新しません")
    previous = path.read_bytes()
    payload = plistlib.loads(previous)
    if payload.get("Label") != LEGACY_LABEL or str(target) not in payload.get("ProgramArguments", []):
        raise ValueError("既存サービスの実行ファイルが対象と一致しません")
    service = f"gui/{os.getuid()}/{LEGACY_LABEL}"
    active = subprocess.run(["launchctl", "print", service], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if not active:
        raise ValueError("既存サービスが起動していません。配置を確認してください")
    ensure_bridge_key(root)
    subprocess.run([sys.executable, str(ROOT / "scripts/install_router_service.py"), "--update-if-idle", "--wait-idle", str(wait_seconds)], check=True)
    # Updating 8788 must not restart/block an unrelated native GPT stream on 8790.
    wait_for_idle(wait_seconds, ports=(8788,))
    if target.read_text() != source or path.read_bytes() != previous:
        raise ValueError("確認中に旧サービスが変更されました。適用していません")
    revision = hashlib.sha256((updated + helper).encode()).hexdigest()
    payload["EnvironmentVariables"] = {**payload.get("EnvironmentVariables", {}), "CODEX_HOME": str(root),
        "DISABLE_DUMP": "1", "ALLOW_REQUEST_DUMP": "0", "PRUNE_EXISTING_DUMPS": "0",
        "CODEX_BRIDGE_TEST_UPSTREAM": "0", "USAGE_HOST": "", "CODEX_BRIDGE_SECURITY_REVISION": revision}
    if plistlib.loads(previous) != payload:
        atomic_write(path.with_name(path.name + ".bak.security." + str(time.time_ns())), previous.decode())
    patch_legacy_security.apply(target)
    try:
        replace_registration(path, payload, service, previous, active, lambda: wait_legacy_health(revision))
    except Exception:
        # replace_registration already restored the old registration. Restore its source,
        # then reload it once more so memory and disk agree (still no Codex restart).
        atomic_write(target, source, target.stat().st_mode & 0o777)
        if module_before is not None:
            atomic_write(module, module_before.decode())
            if manifest_before is None:
                manifest.unlink(missing_ok=True)
            else:
                atomic_write(manifest, manifest_before.decode())
        subprocess.run(["launchctl", "kickstart", "-k", service], check=True)
        raise
    if not doctor(root):
        raise ValueError("診断に失敗しました。各サービスのバックアップを確認してください")
    print("両サービスの本人認証と本文非保存を確認しました。Codexと保存済み会話は変更していません。")


def main():
    parser = argparse.ArgumentParser(description="本人用中継の安全な配置と非課金診断")
    parser.add_argument("mode", choices=["doctor", "prepare-key", "apply"])
    parser.add_argument("--legacy-bridge", type=Path, default=Path.home() / "home-runner/bridge/codex-bridge.mjs")
    parser.add_argument("--wait-idle", type=int, default=120)
    args = parser.parse_args()
    root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser()
    if not 0 <= args.wait_idle <= 1800:
        raise ValueError("待機時間は0〜1800秒です")
    if args.mode == "doctor":
        if not doctor(root):
            raise SystemExit(1)
    elif args.mode == "prepare-key":
        ensure_bridge_key(root)
        print("本人用の内部鍵を確認しました。鍵の表示・ローテーションはしていません。")
    else:
        import fcntl
        descriptor = os.open(root / "security-update.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            apply(root, args.legacy_bridge.expanduser().absolute(), args.wait_idle)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        raise SystemExit("安全な反映・診断を完了できません。接続中の会話、資格情報の所有権と0600権限、サービス登録・バックアップを確認してください。秘密の値は表示していません。")
