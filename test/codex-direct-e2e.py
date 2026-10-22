import importlib.util
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import time
import tomllib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from direct_codex import PROVIDER, configure
from recover_thread import LocalServer
from unified_config import edit_table, prepare

spec = importlib.util.spec_from_file_location("router_e2e", ROOT / "test/codex-router-e2e.py")
router_e2e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(router_e2e)


def run():
    original = os.environ.get("CODEX_HOME")
    original_key = os.environ.get("OPENCODE_API_KEY")
    source = Path(original or Path.home() / ".codex")
    with tempfile.TemporaryDirectory(prefix="codex-direct-e2e-") as directory:
        home = Path(directory)
        for name in ["models_cache.json", "model-catalog.json"]:
            (home / name).write_bytes((source / name).read_bytes())
        prepare(home, ROOT)
        (home / "config.toml").write_text("")
        configure(home)
        environment = {**os.environ, "CODEX_HOME": directory, "MOCK_DIRECT_RESPONSES": "1"}
        upstream = subprocess.Popen(["node", str(ROOT / "test/mock-unified.mjs")], env=environment,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        server = None
        try:
            base = json.loads(upstream.stdout.readline())["url"]
            path = home / "config.toml"
            config = edit_table(path.read_text(), ("model_providers", PROVIDER), {"base_url": base})
            path.write_text(config)
            os.environ["CODEX_HOME"] = directory
            os.environ["OPENCODE_API_KEY"] = "mock-opencode-key"
            binary = os.environ.get("CODEX_BIN", "codex")
            cli = subprocess.run([binary, "--profile", PROVIDER, "exec", "--json", "--skip-git-repo-check",
                                  "--sandbox", "read-only", "Reply OK only. Do not use tools."],
                                 cwd=directory, text=True, capture_output=True, timeout=30)
            assert cli.returncode == 0, cli.stderr
            profile = tomllib.loads((home / (PROVIDER + ".config.toml")).read_text())
            path.write_text(edit_table(config, (), profile))
            server = LocalServer(binary)
            server.request("initialize", {"clientInfo": {"name": "direct-e2e", "version": "1"}})
            server.send({"method": "initialized"})
            thread = server.request("thread/start", {"cwd": directory, "model": "deepseek-v4.1-flash",
                                    "modelProvider": PROVIDER, "sandbox": "read-only", "approvalPolicy": "never"})["thread"]["id"]
            router_e2e.complete_turn(server, thread, "deepseek-v4.1-flash")
            server.request("thread/compact/start", {"threadId": thread})
            deadline = time.monotonic() + 20
            compacted = False
            while time.monotonic() < deadline:
                try:
                    message = server.messages.get(timeout=1)
                except queue.Empty:
                    continue
                if message is None:
                    raise RuntimeError("app-server exited during compaction")
                if message.get("method") == "thread/compacted" or (
                        message.get("method") == "item/completed" and
                        message.get("params", {}).get("item", {}).get("type") == "contextCompaction"):
                    compacted = True
                if compacted and message.get("method") == "turn/completed":
                    assert message.get("params", {}).get("turn", {}).get("status") == "completed", message
                    break
            assert compacted, "local compaction did not finish"
            router_e2e.complete_turn(server, thread, "deepseek-v4.1-flash")
            upstream.stdin.write("summary\n")
            upstream.stdin.flush()
            calls = json.loads(upstream.stdout.readline())["calls"]
            assert len(calls) == 4, calls
            assert all(call["provider"] == "opencode" and call["path"] == "/v1/responses" for call in calls), calls
            assert all(not call["hasNativeAuth"] for call in calls), calls
            print("CLI direct profile + app-server turn -> local compaction -> turn; 4 Responses calls, no GPT or remote compact")
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
            if original_key is None:
                os.environ.pop("OPENCODE_API_KEY", None)
            else:
                os.environ["OPENCODE_API_KEY"] = original_key


if __name__ == "__main__":
    run()
