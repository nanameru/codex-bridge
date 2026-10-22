#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import sys


PROVIDER = "opencode-go-direct"


def api_key(environment, home):
    if environment.get("OPENCODE_API_KEY"):
        return environment["OPENCODE_API_KEY"]
    try:
        auth = json.loads((home / ".local/share/opencode/auth.json").read_text()).get("opencode-go", {})
        return auth.get("key") if auth.get("type") == "api" and isinstance(auth.get("key"), str) else None
    except (OSError, ValueError):
        return None


def run(arguments):
    key = api_key(os.environ, Path.home())
    if not key:
        raise SystemExit("OpenCode GoのAPIキーを設定してください。ログイン認証は流用しません。")
    environment = {**os.environ, "OPENCODE_API_KEY": key}
    return subprocess.run([os.environ.get("CODEX_BIN", "codex"), "--profile", PROVIDER, *arguments], env=environment).returncode


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))
