"""DeepSeekの手動プロバイダー設定。APIキーを表示せずprivate fileへ保存する。"""
import argparse
import getpass
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PROVIDERS = {"commandcode": ("CMD_API_KEY", "commandcode-api-key"), "ollama": ("OLLAMA_API_KEY", "ollama-api-key")}


def private_root(root):
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError("本人だけが書き込める通常のCODEX_HOMEが必要です")


def private_write(path, text):
    if path.is_symlink():
        raise ValueError("リンク先へ設定を書き込みません")
    if path.exists():
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise ValueError("本人の通常ファイルだけを更新します")
    fd, name = tempfile.mkstemp(prefix=".manual-provider-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as out:
            os.fchmod(out.fileno(), 0o600)
            out.write(text)
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def save_key(root, provider, key):
    private_root(root)
    if not key or len(key) > 8192 or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in key):
        raise ValueError("APIキーの形式が不正です")
    private_write(root / PROVIDERS[provider][1], key + "\n")


def install_models(root):
    private_root(root)
    path = root / "unified-model-catalog.json"
    if path.is_symlink() or not path.is_file():
        raise ValueError("通常ファイルのunified-model-catalog.jsonが必要です")
    data = json.loads(path.read_text())
    if not isinstance(data.get("models"), list):
        raise ValueError("カタログの形式が不正です")
    result = subprocess.run(["node", "--input-type=module", "-e",
        "import {withManualModels,MANUAL_PROVIDERS} from './src/manual-providers.mjs'; import {readFileSync} from 'node:fs'; const catalog=JSON.parse(readFileSync(0,'utf8')); process.stdout.write(JSON.stringify(withManualModels(catalog).models.filter(m=>MANUAL_PROVIDERS[m.router_provider])));"],
        cwd=ROOT, check=True, capture_output=True, text=True, input=json.dumps(data))
    models = json.loads(result.stdout)
    prior = data["models"]
    data["models"] = [m for m in prior if m.get("router_provider") not in PROVIDERS] + models
    if data["models"] != prior:
        backup = path.with_name(path.name + ".bak.manual-providers")
        if not backup.exists():
            private_write(backup, path.read_text())
        private_write(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    return [m["slug"] for m in models]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-home", type=Path, default=Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))))
    sub = parser.add_subparsers(dest="command", required=True)
    key = sub.add_parser("set-key", help="非表示入力で公式APIキーを保存する")
    key.add_argument("provider", choices=PROVIDERS)
    sub.add_parser("install-models", help="DeepSeekの手動/自動選択をカタログへ追加する")
    args = parser.parse_args()
    if args.command == "set-key":
        save_key(args.codex_home, args.provider, getpass.getpass(f"{args.provider} API key (非表示): "))
        print(f"{args.provider}のAPIキーを本人専用ファイルへ保存しました。キーは表示しません。")
    else:
        for slug in install_models(args.codex_home):
            print(slug)
        print("稼働ルーターの更新後、Codexを開き直してください。既存CLIは作業終了後に開き直すと一覧を再読込できます。--no-daemonでは表示同期が使えません。")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError):
        raise SystemExit("設定に失敗しました。CODEX_HOMEとファイル権限、Node環境、入力内容を確認してください。APIキーは表示しません。")
