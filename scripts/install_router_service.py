import argparse
import hashlib
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time
from urllib.request import urlopen
from switch_config import atomic_write


def wait_for_unload(service):
    for _attempt in range(30):
        result = subprocess.run(["launchctl", "print", service], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode != 0:
            time.sleep(0.2)
            return
        time.sleep(0.2)
    raise SystemExit("常駐登録の解除待ちがタイムアウトしました")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--update-if-idle", action="store_true")
    arguments = parser.parse_args()
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
    modules = {name: (source / "src" / name).read_bytes() for name in ["model-router.mjs", "tool-adapter.mjs"]}
    revision = hashlib.sha256(b"".join(modules.values())).hexdigest()
    runtime = root / "router-runtime" / revision
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name, content in modules.items():
        atomic_write(runtime / name, content.decode("utf-8"))
    logs = root / "log"
    logs.mkdir(exist_ok=True, mode=0o700)
    label = "com.kimurataiyou.codex-model-router"
    agents = Path.home() / "Library/LaunchAgents"
    agents.mkdir(parents=True, exist_ok=True)
    path = agents / (label + ".plist")
    payload = {
        "Label": label, "ProgramArguments": [node, str(runtime / "model-router.mjs")],
        "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 10,
        "EnvironmentVariables": {"CODEX_HOME": str(root)},
        "StandardOutPath": str(logs / "model-router.log"),
        "StandardErrorPath": str(logs / "model-router.stderr.log"),
    }
    previous = path.read_bytes() if path.exists() else None
    replace = previous is not None and plistlib.loads(previous) != payload
    if replace:
        old = plistlib.loads(previous)
        if not arguments.update_if_idle or old.get("Label") != label or old.get("EnvironmentVariables", {}).get("CODEX_HOME") != str(root):
            raise SystemExit("既存の常駐設定が異なります。更新する場合は--update-if-idleを指定してください")
        connections = subprocess.run(["lsof", "-nP", "-iTCP:8790", "-sTCP:ESTABLISHED"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if connections.returncode != 1:
            raise SystemExit("接続中または接続状態を確認できません。routerを更新していません")
        atomic_write(path.with_name(path.name + ".bak." + str(time.time_ns())), previous.decode("utf-8"))
        atomic_write(path, plistlib.dumps(payload).decode("utf-8"))
    if not path.exists():
        with path.open("xb") as output:
            os.fchmod(output.fileno(), 0o600)
            plistlib.dump(payload, output)
    service = f"gui/{os.getuid()}/{label}"
    active = subprocess.run(["launchctl", "print", service], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if replace and active:
        subprocess.run(["launchctl", "bootout", service], check=True)
        wait_for_unload(service)
        active = False
    if not active:
        try:
            subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(path)], check=True)
        except subprocess.CalledProcessError:
            if replace:
                atomic_write(path, previous.decode("utf-8"))
                subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(path)], check=False)
            raise
    for _attempt in range(30):
        try:
            with urlopen("http://127.0.0.1:8790/health", timeout=1) as response:
                if response.status == 200:
                    print("共通routerを起動しました。既存のCodex・OpenCodeブリッジは再起動していません。")
                    return
        except OSError:
            pass
        time.sleep(0.2)
    raise SystemExit("routerの起動を確認できません。設定はまだ有効化していません")


if __name__ == "__main__":
    main()
