#!/usr/bin/env python3
"""Recorded TC-125 entry point for an unmodified distribution ZIP and a local mock."""
import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from build_distribution import readback

MODEL = "deepseek-v4.1-flash"
MOCK_KEY = "tc125-synthetic-opencode-key"
CODEX_KEY = "tc125-synthetic-codex-key"
ANSWER = "BRIDGE_OK"
WORKER = (
    "import runpy, sys; "
    "runpy.run_path(sys.argv[1])['exercise'](sys.argv[2], sys.argv[3], "
    "sys.argv[4], int(sys.argv[5]), int(sys.argv[6]))"
)


def file_digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def prepare_archive(source, expected, work):
    # Check the same private copy that will be validated and extracted.
    archive = work / "distribution.zip"
    shutil.copyfile(source, archive)
    if file_digest(archive) != expected:
        raise ValueError("distribution ZIP SHA-256 mismatch")
    readback(archive)
    destination = work / "distribution"
    with zipfile.ZipFile(archive) as contents:
        contents.extractall(destination)
    return destination


def sandbox_command(platform, work, ports, worker):
    if platform == "darwin" and os.access("/usr/bin/sandbox-exec", os.X_OK):
        profile = [
            "(version 1)", "(allow default)", "(deny network*)",
            '(allow network-bind (local ip "localhost:*"))',
            '(allow network-inbound (local ip "localhost:*"))',
        ]
        profile.extend(f'(allow network-outbound (remote ip "localhost:{port}"))' for port in ports)
        return ["/usr/bin/sandbox-exec", "-p", "\n".join(profile), *worker]
    if platform.startswith("linux") and (bwrap := shutil.which("bwrap")):
        return [bwrap, "--unshare-net", "--unshare-pid", "--die-with-parent",
                "--ro-bind", "/", "/", "--bind", str(work), str(work),
                "--proc", "/proc", "--dev", "/dev", "--dev-bind", "/dev/tty", "/dev/tty",
                "--tmpfs", "/run", "--", *worker]
    raise RuntimeError("network isolation unavailable (macOS sandbox-exec or Linux/WSL Bubblewrap required)")


def prepare_session(work, node, codex, mock_port):
    home, tools = work / "home", work / "bin"
    codex_home, tmp = home / ".codex", work / "tmp"
    codex_home.mkdir(parents=True, mode=0o700)
    tools.mkdir(mode=0o700)
    tmp.mkdir(mode=0o700)
    config = codex_home / "config.toml"
    config.write_text('cli_auth_credentials_store = "file"\n', encoding="utf-8")
    auth = codex_home / "auth.json"
    with open(auth, "x", encoding="utf-8", opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
        json.dump({"auth_mode": "apikey", "OPENAI_API_KEY": CODEX_KEY}, stream)
    answer = work / "last-message.txt"

    # Wrap only the exact archived Bridge entry point. The auth probe and version
    # probe execute the installed Node normally, with the launcher's filtered env.
    bridge = work / "distribution/src/codex-bridge.mjs"
    upstream = f"UPSTREAM_BASE=http://127.0.0.1:{mock_port}/v1"
    node_wrapper = (
        "#!/bin/sh\n"
        f'if [ "$1" = {shlex.quote(str(bridge))} ]; then\n'
        f'  [ "${{OPENCODE_API_KEY:-}}" = {shlex.quote(MOCK_KEY)} ] || exit 1\n'
        f'  exec /usr/bin/env CODEX_BRIDGE_TEST_UPSTREAM=1 {upstream} {shlex.quote(node)} "$@"\n'
        "fi\n"
        f'exec {shlex.quote(node)} "$@"\n'
    )
    exec_args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only",
                 "--output-last-message", str(answer), "Reply BRIDGE_OK. Do not use tools."]
    codex_wrapper = f'#!/bin/sh\nexec {shlex.quote(codex)} "$@" {shlex.join(exec_args)}\n'
    for name, content in (("node", node_wrapper), ("codex", codex_wrapper)):
        target = tools / name
        target.write_text(content, encoding="utf-8")
        target.chmod(0o700)
    env = {"HOME": str(home), "CODEX_HOME": str(codex_home), "TMPDIR": str(tmp),
           "PATH": f"{tools}:/usr/bin:/bin", "LANG": "C", "TERM": "dumb"}
    return config, answer, env


def port_is_open(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
        connection.settimeout(1)
        status = connection.connect_ex(("127.0.0.1", port))
    if status == errno.ECONNREFUSED:
        return False
    if status:
        raise OSError(status, f"could not verify loopback port {port}")
    return True


def wait_for_mock(mock, port, log):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if mock.poll() is not None:
            break
        if f"[mock] listening {port}" in log.read_text(encoding="utf-8").splitlines():
            if port_is_open(port) and mock.poll() is None:
                return
            break
        time.sleep(0.05)
    raise RuntimeError("mock upstream did not become ready; launcher not started")


def stop_mock(mock):
    if mock.poll() is None:
        mock.terminate()
        try:
            mock.wait(timeout=5)
        except subprocess.TimeoutExpired:
            mock.kill()
            mock.wait()


def exercise(work_path, node, codex, bridge_port, mock_port):
    work = Path(work_path)
    if sys.platform.startswith("linux") and {name for _, name in socket.if_nameindex()} != {"lo"}:
        raise RuntimeError("network namespace has a non-loopback interface")
    if port_is_open(bridge_port) or port_is_open(mock_port):
        raise RuntimeError("test port already occupied; launcher not started")

    config, answer, env = prepare_session(work, node, codex, mock_port)
    before = file_digest(config)
    launcher = [sys.executable, "-E", "-s", str(work / "distribution/scripts/portable_setup.py")]
    options = ["--port", str(bridge_port)]
    choices = ["--provider", "opencode-go", "--model", MODEL]
    log = work / "mock.log"
    with log.open("w", encoding="utf-8") as output:
        mock = subprocess.Popen([node, str(ROOT / "test/mock-upstream.mjs")],
                                cwd=work, env={"MOCK_PORT": str(mock_port)},
                                stdout=output, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        failure = None
        try:
            wait_for_mock(mock, mock_port, log)
            for step, args in (("preflight", options), ("preview", [*options, *choices])):
                subprocess.run([*launcher, step, *args], cwd=work, env=env, check=True, timeout=20)
            print(f"At the launcher prompts, type YES and then {MOCK_KEY}.", flush=True)
            if mock.poll() is not None:
                raise RuntimeError("mock upstream exited before run")
            subprocess.run([*launcher, "run", *options, *choices], cwd=work, env=env, check=True)
            if not answer.is_file() or answer.read_text(encoding="utf-8").strip() != ANSWER:
                raise RuntimeError("Codex did not return the expected mock response")
            if not any(line.startswith("[mock] POST /v1/chat/completions ")
                       for line in log.read_text(encoding="utf-8").splitlines()):
                raise RuntimeError("mock did not receive a chat completions request")
        except BaseException as exc:
            failure = exc
            raise
        finally:
            try:
                stop_mock(mock)
                if port_is_open(bridge_port) or port_is_open(mock_port):
                    raise RuntimeError("Bridge or mock listener still open")
                if file_digest(config) != before:
                    raise RuntimeError("config.toml changed")
            except Exception as exc:
                if failure is None:
                    raise
                failure.add_note(f"Cleanup verification also failed: {exc}")
    print(f"PASS: Codex returned {ANSWER} through the mock upstream. "
          f"Bridge and mock stopped. config.toml SHA-256 unchanged: {before}", flush=True)


def port_arg(text):
    port = int(text)
    if not 1024 <= port <= 65535:
        raise argparse.ArgumentTypeError("test port must be 1024..65535")
    return port


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("zip", type=Path, help="trusted ZIP for the recorded run")
    parser.add_argument("--sha256", required=True, help="expected SHA-256 from the distribution build record")
    parser.add_argument("--codex", default="codex", help="installed Codex CLI executable")
    parser.add_argument("--port", type=port_arg, default=18788)
    parser.add_argument("--mock-port", type=port_arg, default=18999)
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        parser.error("Python 3.11 or newer is required")
    expected = args.sha256.lower()
    if len(expected) != 64 or any(char not in "0123456789abcdef" for char in expected):
        parser.error("--sha256 must contain 64 hex digits")
    if args.port == args.mock_port:
        parser.error("Bridge and mock ports must differ")
    if not sys.stdin.isatty():
        parser.error("an interactive terminal is required for explicit launcher approval")
    node, codex = shutil.which("node"), shutil.which(args.codex)
    if not node or not codex:
        parser.error("installed Node.js and Codex CLI are required")

    try:
        with tempfile.TemporaryDirectory(prefix="tc125-", dir="/tmp") as directory:
            work = Path(directory).resolve()
            worker = [sys.executable, "-I", "-c", WORKER, str(Path(__file__).resolve()),
                      str(work), os.path.abspath(node), os.path.abspath(codex),
                      str(args.port), str(args.mock_port)]
            command = sandbox_command(sys.platform, work, (args.port, args.mock_port), worker)
            prepare_archive(args.zip, expected, work)
            print(f"Verified distribution ZIP SHA-256: {expected}", flush=True)
            subprocess.run(command, cwd=work,
                           env={"HOME": str(work), "PATH": "/usr/bin:/bin", "LANG": "C", "TERM": "dumb"},
                           check=True)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, zipfile.BadZipFile,
            KeyboardInterrupt) as exc:
        parser.exit(1, f"TC-125 launcher verification stopped: {exc}\n")


if __name__ == "__main__":
    main()
