"""Verify the exact app-server events consumed by Codex App and CLI, with fake upstreams."""
import importlib.util
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from recover_thread import LocalServer
from unified_config import prepare

spec = importlib.util.spec_from_file_location("router_e2e", ROOT / "test/codex-router-e2e.py")
e2e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e2e)


def start(binary):
    server = LocalServer(binary)
    server.request("initialize", {"clientInfo": {"name": "handoff-app-e2e", "version": "1"},
                                  "capabilities": {"experimentalApi": True}})
    server.send({"method": "initialized"})
    return server


def turn(server, thread, model):
    result = server.request("turn/start", {"threadId": thread, "model": model,
                            "input": [{"type": "text", "text": "Reply OK only. Do not use tools."}]})
    identifier = result["turn"]["id"]
    deadline = time.monotonic() + 30
    messages = []
    while time.monotonic() < deadline:
        try:
            message = server.messages.get(timeout=1)
        except queue.Empty:
            continue
        if message is None:
            raise RuntimeError("app-server exited")
        messages.append(message)
        if message.get("method") == "turn/completed" and message.get("params", {}).get("turn", {}).get("id") == identifier:
            return messages, message["params"]["turn"]["status"]
    raise RuntimeError("turn timed out")


def run(fail=False):
    original = os.environ.get("CODEX_HOME")
    source = Path(original or Path.home() / ".codex")
    with tempfile.TemporaryDirectory(prefix="codex-handoff-app-") as directory:
        home = Path(directory)
        for filename in ["models_cache.json", "model-catalog.json"]:
            (home / filename).write_bytes((source / filename).read_bytes())
        prepare(home, ROOT)
        (home / "auth.json").write_text(json.dumps(e2e.fake_auth()))
        (home / "auth.json").chmod(0o600)
        env = {**os.environ, "CODEX_HOME": directory, "MOCK_HANDOFF_FAIL": "1" if fail else "0"}
        upstream = subprocess.Popen(["node", str(ROOT / "test/mock-handoff.mjs")], env=env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        server = None
        try:
            base = json.loads(upstream.stdout.readline())["url"]
            (home / "config.toml").write_text('model="gpt-6.1-sol"\nmodel_provider="openai"\n'
                                             'openai_base_url=' + json.dumps(base) + '\nmodel_catalog_json='
                                             + json.dumps(str(home / "unified-model-catalog.json")) + '\n')
            os.environ["CODEX_HOME"] = directory
            binary = os.environ.get("CODEX_BIN", "codex")
            server = start(binary)
            info = server.request("thread/start", {"cwd": directory, "sandbox": "read-only", "approvalPolicy": "never"})
            thread = info["thread"]["id"]
            initial, status = turn(server, thread, "gpt-6.1-sol")
            assert status == "completed"
            assert not any("接続ステータス" in m.get("params", {}).get("delta", "") for m in initial)
            server.request("thread/compact/start", {"threadId": thread})
            # Wait for the remote compaction to finish; it is not an ordinary model turn.
            deadline = time.monotonic() + 30
            compacted = False
            while time.monotonic() < deadline:
                try:
                    message = server.messages.get(timeout=1)
                except queue.Empty:
                    continue
                if message is None:
                    raise RuntimeError("app-server exited while compacting")
                if message.get("method") == "item/completed" and message.get("params", {}).get("item", {}).get("type") == "contextCompaction":
                    compacted = True
                if compacted and message.get("method") == "turn/completed":
                    break
            assert compacted, "native encrypted compaction was not installed"
            notifications, status = turn(server, thread, "opencode/deepseek-v4.1-flash")
            deltas = [(i, m.get("params", {}).get("delta", "")) for i, m in enumerate(notifications)
                      if m.get("method") == "item/agentMessage/delta"]
            assert any("会話履歴を引き継いでいます" in text for _i, text in deltas), [m.get("method") for m in notifications]
            if fail:
                assert status == "failed", status
                assert not any("opencode_OK" in text for _i, text in deltas)
            else:
                assert status == "completed", status
                waiting = next(i for i, text in deltas if "引き継いでいます" in text)
                answer = next(i for i, text in deltas if "opencode_OK" in text)
                assert waiting < answer
                assert any("引き継ぎが完了" in text for _i, text in deltas)
                later, status = turn(server, thread, "opencode/deepseek-v4.1-flash")
                assert status == "completed"
                assert not any("接続ステータス" in m.get("params", {}).get("delta", "") for m in later)
                server.close()
                server = start(binary)
                resumed = server.request("thread/resume", {"threadId": thread, "excludeTurns": True})
                assert resumed["thread"]["id"] == thread
                after_resume, status = turn(server, thread, "gpt-6.1-sol")
                assert status == "completed"
            upstream.stdin.write("summary\n")
            upstream.stdin.flush()
            calls = json.loads(upstream.stdout.readline())["calls"]
            assert sum(bool(c["summary"]) for c in calls) == 1, calls
            assert any(c["compact"] and c["provider"] == "openai" for c in calls)
            assert all(c["hasNativeAuth"] == (c["provider"] == "openai") for c in calls)
            assert not any(c["statusReplayed"] for c in calls), calls
            print("Codex App/CLI app-server: native encrypted compaction preserved; delayed handoff commentary -> "
                  + ("failure, no OpenCode request" if fail else "answer; cache hit hidden; resume succeeds")
                  + "; auth isolated; bridge status not replayed")
        finally:
            if server:
                server.close()
            upstream.stdin.close()
            try:
                upstream.wait(timeout=5)
            except subprocess.TimeoutExpired:
                upstream.terminate()
                upstream.wait(timeout=5)
            if original is None:
                os.environ.pop("CODEX_HOME", None)
            else:
                os.environ["CODEX_HOME"] = original


if __name__ == "__main__":
    run(fail="--fail" in sys.argv)
