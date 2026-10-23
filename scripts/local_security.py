"""Local credentials and non-inference health checks. Never return secret values to stdout."""
import json
import os
from pathlib import Path
import re
import secrets
import stat
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

SECURITY_VERSION = "local-owner-v1"


def private_read(root, name):
    parent = root.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o022:
        raise ValueError("設定ディレクトリの所有者・書込み権限を確認してください")
    descriptor = os.open(root / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor) as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077
                or info.st_nlink != 1 or info.st_size > 65536):
            raise ValueError("資格情報は本人所有・0600相当の通常ファイルにしてください")
        return source.read(65537)


def ensure_bridge_key(root):
    path = root / "bridge-local-token"
    if not path.exists() and not path.is_symlink():
        # Check the parent before creating anything, including an exclusive 0600 file.
        parent = root.lstat()
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o022:
            raise ValueError("設定ディレクトリが安全ではありません")
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(descriptor, "w") as output:
                output.write(secrets.token_hex(32) + "\n")
                output.flush()
                os.fsync(output.fileno())
    if not re.fullmatch(r"[a-f0-9]{64}", private_read(root, "bridge-local-token").strip()):
        raise ValueError("既存のローカル鍵の形式が不正です。上書きしません")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def get_health(port):
    with build_opener(NoRedirect).open(f"http://127.0.0.1:{port}/health", timeout=3) as response:
        return json.load(response)


def verify_service(port, revision=None):
    health = get_health(port)
    if health.get("security") != SECURITY_VERSION or health.get("request_dump") is True:
        raise ValueError("保護版のサービスではないか、本文dumpが有効です")
    if revision and health.get("implementation") != revision:
        raise ValueError("稼働revisionが配置した実装と一致しません")
    request = Request(f"http://127.0.0.1:{port}/v1/responses", data=b"{}", method="POST",
                      headers={"Authorization": "Bearer invalid-local-probe", "Content-Type": "application/json"})
    try:
        with build_opener(NoRedirect).open(request, timeout=3):
            raise ValueError("認証なしの要求が拒否されませんでした")
    except HTTPError as error:
        if error.code != 401:
            raise ValueError("認証拒否の動作を確認できません") from None
    return health
