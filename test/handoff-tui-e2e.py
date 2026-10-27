"""Real Codex TUI + loopback mocks: handoff -> Working -> tool execution -> answer.

Optional terminal-test dependency: uv run --no-project --with pyte python test/handoff-tui-e2e.py
No real credentials or model API calls are used. Requires Codex 0.164.0.
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

import pyte

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("handoff", ROOT / "test/handoff-app-e2e.py")
handoff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handoff)


def run():
    source = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    binary = os.environ.get("CODEX_BIN", "codex")
    previous = os.environ.get("CODEX_HOME")
    previous_key = os.environ.get("OPENAI_API_KEY")
    with tempfile.TemporaryDirectory(prefix="codex-handoff-tui-") as directory:
        home = Path(directory)
        for name in ["models_cache.json", "model-catalog.json"]:
            (home / name).write_bytes((source / name).read_bytes())
        handoff.prepare(home, ROOT)
        (home / "auth.json").write_text(json.dumps({"OPENAI_API_KEY": "sk-test-only"}))
        (home / "auth.json").chmod(0o600)
        env = {**os.environ, "CODEX_HOME": directory, "TERM": "xterm-256color",
               "MOCK_HANDOFF_TOOLS": "1", "MOCK_HANDOFF_DELAY_MS": "1500", "OPENAI_API_KEY": "sk-test-only"}
        upstream = subprocess.Popen(["node", str(ROOT / "test/mock-handoff.mjs")], env=env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        server = None
        child = None
        master = None
        try:
            base = json.loads(upstream.stdout.readline())["url"]
            (home / "config.toml").write_text(
                'model="gpt-6.1-sol"\nmodel_provider="openai"\n'
                'openai_base_url=' + json.dumps(base) + '\nmodel_catalog_json='
                + json.dumps(str(home / "unified-model-catalog.json")) + '\n'
                '[features]\nshell_snapshot=false\n')
            os.environ["CODEX_HOME"] = directory
            os.environ["OPENAI_API_KEY"] = "sk-test-only"
            server = handoff.start(binary)
            thread = server.request("thread/start", {"cwd": directory, "sandbox": "read-only",
                                                     "approvalPolicy": "never"})["thread"]["id"]
            _, status = handoff.turn(server, thread, "gpt-6.1-sol")
            assert status == "completed"
            handoff.compact(server, thread)
            server.close()
            server = None
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
            # Start from a fresh interpreter: forking after app-server reader threads
            # can inherit runtime locks on macOS.
            wrapper = "import fcntl,os,sys,termios; fcntl.ioctl(0,termios.TIOCSCTTY,0); os.execvpe(sys.argv[1],sys.argv[1:],os.environ)"
            child = subprocess.Popen([sys.executable, "-c", wrapper, binary, "--no-daemon", "--no-alt-screen", "resume", thread,
                "-m", "opencode/deepseek-v4.1-flash", "-s", "danger-full-access", "-a", "never",
                "Run the mock printf check, then answer."], env=env, cwd=directory,
                stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
            os.close(slave)
            screen = pyte.Screen(140, 40)
            terminal = pyte.ByteStream(screen)
            deadline = time.monotonic() + 30
            seen_wait = False
            seen_working = False
            seen_working_after_tool = False
            seen_answer = False
            samples = []
            query_buffer = b""
            while time.monotonic() < deadline:
                if not select.select([master], [], [], 0.2)[0]:
                    continue
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                query_buffer += chunk
                while b"\x1b[6n" in query_buffer:
                    _before, query_buffer = query_buffer.split(b"\x1b[6n", 1)
                    os.write(master, b"\x1b[1;1R")
                query_buffer = query_buffer[-8:]
                terminal.feed(chunk)
                # Read cells directly: pyte.display can fail on wide-character stubs.
                lines = ["".join(screen.buffer[y][x].data for x in range(screen.columns))
                         for y in range(screen.lines)]
                text = "\n".join(lines)
                if "trust this folder" in text.lower() or "trust the contents" in text.lower():
                    os.write(master, b"\r")
                headings = [line.strip() for line in lines if "esc to interrupt" in line.lower()]
                seen_wait |= any("履歴を変換中" in line for line in headings)
                working = any("Working" in line for line in headings)
                seen_working |= seen_wait and working
                seen_working_after_tool |= seen_wait and working and "BRIDGE_STATUS_TOOL_OK" in text
                if headings and (not samples or headings[-1] != samples[-1]):
                    samples.append(headings[-1])
                assert not any("モデルの応答待ち" in line for line in headings), headings
                if "opencode_OK" in text and seen_working_after_tool and not headings:
                    seen_answer = True
                    break
            assert seen_wait, "conversion progress was not rendered: " + repr(samples) + "\n" + text
            assert seen_working, "Working was not restored: " + repr(samples)
            assert seen_working_after_tool, "Working did not survive tools/empty reasoning: " + repr(samples) + "\n" + text
            assert seen_answer, "final answer did not clear running status: " + repr(samples)
            upstream.stdin.write("summary\n")
            upstream.stdin.flush()
            calls = json.loads(upstream.stdout.readline())["calls"]
            assert sum(call["summary"] for call in calls) == 1, calls
            selected = [call for call in calls if call["provider"] == "opencode"]
            assert 2 <= len(selected) <= 4, selected
            assert max(call["toolResults"] for call in selected) == 1, selected
            assert all(not call["statusReplayed"] for call in calls), calls
            assert any("function_call_output" in call["inputTypes"] for call in selected), selected
            print("Real Codex TUI: conversion -> Working -> printf tool + empty reasoning/cache hit -> Working -> answer/status cleared; model API calls=0")
        finally:
            if server:
                server.close()
            if child:
                child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=3)
            if master is not None:
                os.close(master)
            upstream.stdin.close()
            try:
                upstream.wait(timeout=5)
            except subprocess.TimeoutExpired:
                upstream.terminate()
                upstream.wait(timeout=5)
            if previous_key is None:
                os.environ.pop("OPENAI_API_KEY", None)
            else:
                os.environ["OPENAI_API_KEY"] = previous_key
            if previous is None:
                os.environ.pop("CODEX_HOME", None)
            else:
                os.environ["CODEX_HOME"] = previous


if __name__ == "__main__":
    run()
