import argparse
import hashlib
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import time
from switch_config import atomic_write
from local_security import ensure_bridge_key, verify_service, service_environment

ROUTER_SERVICES = {
    "com.kimurataiyou.codex-model-router": 8790,
    "com.kimurataiyou.codex-model-router-8791": 8791,
}


INPUT_LIMIT_NAMES = ("ROUTER_MAX_FORWARDED_BYTES", "ROUTER_MAX_REQUEST_BYTES")
INPUT_LIMIT_DEFAULT = 128 * 1024 * 1024
INPUT_LIMIT_CEILING = 512 * 1024 * 1024


def router_input_environment(previous):
    # An explicitly supplied installer environment overrides the old registration.
    environment = dict(previous)
    for name in INPUT_LIMIT_NAMES:
        if name in os.environ:
            environment[name] = os.environ[name]
    values = []
    for name in INPUT_LIMIT_NAMES:
        raw = environment.get(name, str(INPUT_LIMIT_DEFAULT))
        if not isinstance(raw, str) or not re.fullmatch(r"[0-9]+", raw):
            raise ValueError(f"{name} must be a positive integer in bytes")
        value = int(raw)
        if not 1 <= value <= INPUT_LIMIT_CEILING:
            raise ValueError(f"{name} must be between 1 and {INPUT_LIMIT_CEILING} bytes")
        values.append(value)
    if values[1] < values[0]:
        raise ValueError("ROUTER_MAX_REQUEST_BYTES must be at least ROUTER_MAX_FORWARDED_BYTES")
    return environment


def wait_for_unload(service):
    for _attempt in range(30):
        result = subprocess.run(["launchctl", "print", service], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode != 0:
            time.sleep(0.2)
            return
        time.sleep(0.2)
    raise SystemExit("常駐登録の解除待ちがタイムアウトしました")


def wait_for_idle(timeout, ports=(8790,)):
    deadline = time.monotonic() + timeout
    notified = False
    while True:
        states = [subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:ESTABLISHED"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode for port in ports]
        if all(status == 1 for status in states):
            return
        if any(status not in (0, 1) for status in states) or time.monotonic() >= deadline:
            raise SystemExit("接続中または接続状態を確認できません。routerを更新していません")
        if not notified:
            print("会話の接続が空くまで待機します。実行中の接続は停止しません。", flush=True)
            notified = True
        time.sleep(min(5, max(0, deadline - time.monotonic())))


def replace_registration(path, payload, service, previous, active, verify):
    """Restore both the registration and running service if startup/verification fails."""
    changed = previous is None or plistlib.loads(previous) != payload
    started = False
    stopped = False
    try:
        if changed and active:
            subprocess.run(["launchctl", "bootout", service], check=True)
            stopped = True
            wait_for_unload(service)
        if changed:
            atomic_write(path, plistlib.dumps(payload).decode("utf-8"))
        if not active or changed:
            # Mark before bootstrap: even a failed command may leave a registration.
            started = True
            subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(path)], check=True)
        verify()
    except Exception:
        if started:
            subprocess.run(["launchctl", "bootout", service], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            wait_for_unload(service)
        if changed:
            if previous is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, previous.decode("utf-8"))
        if stopped:
            subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(path)], check=True)
        raise


def wait_for_health(port, revision):
    for _attempt in range(30):
        try:
            verify_service(port, revision)
            return
        except (OSError, ValueError):
            time.sleep(0.2)
    raise ValueError("更新したrevisionと認証拒否を確認できません")


def install():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--update-if-idle", action="store_true")
    mode.add_argument("--update-now", action="store_true", help="本人の明示指定で通信中でも今更新します")
    parser.add_argument("--wait-idle", type=int, default=0)
    parser.add_argument("--service", choices=sorted(ROUTER_SERVICES), default="com.kimurataiyou.codex-model-router",
                        help="更新する既知のrouterサービス（既定: 8790）")
    parser.add_argument("--enable-whatstoken-free", action="store_true", help="WhatsTokenを無料条件確認付きの自動ルートへ追加する")
    arguments = parser.parse_args()
    if not 0 <= arguments.wait_idle <= 1800:
        raise SystemExit("接続待機は0〜1800秒で指定してください")
    if sys.platform != "darwin":
        raise SystemExit("この常駐設定はmacOS専用です。その他のOSではnode src/model-router.mjsを起動してください")
    node = shutil.which("node")
    if not node:
        raise SystemExit("Node.jsが必要です")
    subprocess.run([node, "-e", 'if (typeof require("node:zlib").zstdDecompressSync !== "function") process.exit(1)'], check=True)
    source = Path(__file__).resolve().parents[1]
    root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser().resolve()
    if not (root / "unified-model-catalog.json").exists():
        raise SystemExit("先にunified_config.py prepareを実行してください")
    label = arguments.service
    port = ROUTER_SERVICES[label]
    agents = Path.home() / "Library/LaunchAgents"
    path = agents / (label + ".plist")
    if path.is_symlink():
        raise SystemExit("リンクされた常駐設定は更新しません")
    previous = path.read_bytes() if path.exists() else None
    prior_environment = plistlib.loads(previous).get("EnvironmentVariables", {}) if previous else {}
    try:
        configured_environment = router_input_environment(prior_environment)
    except ValueError as exc:
        raise SystemExit(str(exc)) from None
    environment = service_environment(configured_environment, node=node)
    ensure_bridge_key(root)
    modules = {name: (source / "src" / name).read_bytes() for name in ["model-router.mjs", "tool-adapter.mjs", "compaction-handoff.mjs", "local-security.mjs", "handoff-status.mjs", "tool-recovery.mjs", "live-catalog.mjs", "make-catalog.mjs", "sync-models.mjs", "catalog-safety.mjs", "manual-providers.mjs", "whatstoken-free.mjs", "provider-fallback.mjs", "cli-control.mjs", "cli-model-sync.mjs", "provider-help.mjs", "chat-protocol.mjs", "tool-search.mjs", "usage.mjs", "upstream-options.mjs", "request-guard.mjs", "history-mode.mjs", "rollout-history.mjs", "selected-compaction.mjs", "models.json"]}
    revision = hashlib.sha256(b"".join(modules.values())).hexdigest()
    runtime = root / "router-runtime" / revision
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name, content in modules.items():
        atomic_write(runtime / name, content.decode("utf-8"))
    logs = root / "log"
    logs.mkdir(exist_ok=True, mode=0o700)
    agents.mkdir(parents=True, exist_ok=True)
    payload = {
        "Label": label, "ProgramArguments": [node, str(runtime / "model-router.mjs")],
        "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 10,
        "EnvironmentVariables": {**environment, "CODEX_HOME": str(root)},
        "StandardOutPath": str(logs / "model-router.log") if port == 8790 else str(logs / f"model-router-{port}.log"),
        "StandardErrorPath": str(logs / "model-router.stderr.log") if port == 8790 else str(logs / f"model-router-{port}.stderr.log"),
    }
    if previous:
        registered_port = payload["EnvironmentVariables"].get("ROUTER_PORT")
        if registered_port is not None and str(registered_port) != str(port):
            raise SystemExit("常駐設定のROUTER_PORTが選択したサービスと一致しません。更新していません")
    if port != 8790:
        payload["EnvironmentVariables"]["ROUTER_PORT"] = str(port)
    if arguments.enable_whatstoken_free:
        payload["EnvironmentVariables"]["CODEX_WHATSTOKEN_FREE"] = "1"
    replace = previous is not None and plistlib.loads(previous) != payload
    if replace:
        old = plistlib.loads(previous)
        if not (arguments.update_if_idle or arguments.update_now) or old.get("Label") != label or old.get("EnvironmentVariables", {}).get("CODEX_HOME") != str(root):
            raise SystemExit("既存の常駐設定が異なります。更新する場合は--update-if-idleを指定してください")
        if arguments.update_now:
            print("今すぐrouterを更新します。通信中の要求は切断されることがあります。Codex本体は再起動しません。", flush=True)
        else:
            wait_for_idle(arguments.wait_idle, ports=(port,))
        atomic_write(path.with_name(path.name + ".bak." + str(time.time_ns())), previous.decode("utf-8"))
    service = f"gui/{os.getuid()}/{label}"
    active = subprocess.run(["launchctl", "print", service], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if active and previous is None:
        raise SystemExit("登録済みサービスの元定義がありません。上書き・停止しません")
    replace_registration(path, payload, service, previous, active, lambda: wait_for_health(port, revision))
    print(f"{label} (port {port}) のrevisionと認証拒否を確認しました。Codex・OpenCodeブリッジは再起動していません。")


def main():
    import fcntl
    root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser()
    descriptor = os.open(root / "router-service-update.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        install()


if __name__ == "__main__":
    main()
