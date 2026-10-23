"""Real Codex, isolated config and fake upstream: plaintext compaction across providers."""
import argparse
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
from portable_history import candidate_config, read_catalog
from recover_thread import LocalServer
from unified_config import edit_table, prepare

spec = importlib.util.spec_from_file_location("router_e2e", ROOT / "test/codex-router-e2e.py")
e2e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e2e)


def compact(server, thread):
    server.request("thread/compact/start", {"threadId": thread})
    deadline = time.monotonic() + 30
    completed = False
    while time.monotonic() < deadline:
        try:
            message = server.messages.get(timeout=1)
        except queue.Empty:
            continue
        if message is None:
            raise RuntimeError("app-server exited during compaction")
        if message.get("method") == "thread/compacted" or (
                message.get("method") == "item/completed"
                and message.get("params", {}).get("item", {}).get("type") == "contextCompaction"):
            completed = True
        if completed and message.get("method") == "turn/completed":
            assert message["params"]["turn"]["status"] == "completed", message
            return
    raise RuntimeError("local compaction did not complete")


def start(binary):
    server = LocalServer(binary)
    server.request("initialize", {"clientInfo": {"name": "portable-history-e2e", "version": "1"}, "capabilities": {"experimentalApi": True}})
    server.send({"method": "initialized"})
    return server


def run(*, tools=False, start_opencode=False):
    original = os.environ.get("CODEX_HOME")
    original_tools = os.environ.pop("MOCK_TOOL_ROUNDTRIP", None)
    source = Path(original or Path.home() / ".codex")
    with tempfile.TemporaryDirectory(prefix="codex-portable-e2e-") as directory:
        home = Path(directory)
        for filename in ["models_cache.json", "model-catalog.json"]:
            (home / filename).write_bytes((source / filename).read_bytes())
        prepare(home, ROOT)
        (home / "auth.json").write_text(json.dumps(e2e.fake_auth()))
        (home / "auth.json").chmod(0o600)
        environment = {**os.environ, "CODEX_HOME": directory}
        environment.pop("MOCK_DIRECT_RESPONSES", None)
        if tools:
            environment["MOCK_TOOL_ROUNDTRIP"] = "1"
        else:
            environment.pop("MOCK_TOOL_ROUNDTRIP", None)
        upstream = subprocess.Popen(["node", str(ROOT / "test/mock-unified.mjs")], env=environment,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        server = None
        try:
            base = json.loads(upstream.stdout.readline())["url"]
            config = ('model="gpt-6.1-sol"\nmodel_provider="openai"\nmodel_catalog_json='
                      + json.dumps(str(home / "unified-model-catalog.json"))
                      + '\n[model_providers.codex-bridge]\nname="Codex Bridge"\n'
                      'base_url="http://127.0.0.1:8790/v1"\nrequires_openai_auth=true\nwire_api="responses"\n'
                      '[model_providers.codex-bridge.http_headers]\nx-codex-bridge-direct="1"\n')
            configured = candidate_config(config, home, read_catalog(home))
            # Redirect only this disposable test provider to the ephemeral mock listener.
            configured = edit_table(configured, ("model_providers", "codex-bridge"), {"base_url": base})
            (home / "config.toml").write_text(configured)
            (home / "config.toml").chmod(0o600)
            os.environ["CODEX_HOME"] = directory
            if tools:
                os.environ["MOCK_TOOL_ROUNDTRIP"] = "1"
            flow = ["gpt-6.1-sol", "opencode/deepseek-v4.1-flash"]
            if start_opencode:
                flow.reverse()
            flow *= 2
            binary = os.environ.get("CODEX_BIN", "codex")
            server = start(binary)
            params = {"cwd": directory, "sandbox": "read-only", "approvalPolicy": "never", "model": flow[0]}
            if tools:
                params["dynamicTools"] = [{"type": "function", "name": "route_probe", "description": "Return ROUTE_OK",
                                           "inputSchema": {"type": "object", "properties": {}}}]
            info = server.request("thread/start", params)
            assert info["modelProvider"] == "codex-bridge"
            thread = info["thread"]["id"]
            e2e.complete_turn(server, thread, flow[0])
            compact(server, thread)
            e2e.complete_turn(server, thread, flow[1])
            compact(server, thread)
            e2e.complete_turn(server, thread, flow[2])
            server.close()
            server = start(binary)
            resumed = server.request("thread/resume", {"threadId": thread, "excludeTurns": True})
            assert resumed["thread"]["id"] == thread
            assert resumed["modelProvider"] == "codex-bridge"
            e2e.complete_turn(server, thread, flow[3])
            server.close()
            server = None
            upstream.stdin.write("summary\n")
            upstream.stdin.flush()
            calls = json.loads(upstream.stdout.readline())["calls"]
            expected = []
            for index, model in enumerate(flow):
                provider = "opencode" if model.startswith("opencode/") else "openai"
                expected.extend([provider] * (2 if tools else 1))
                if index < 2:
                    expected.append(provider)
            assert len(calls) == len(expected), calls
            assert [c["provider"] for c in calls] == expected
            assert all(c["path"] == "/v1/responses" for c in calls)
            assert all("compaction" not in (c["inputTypes"] or []) for c in calls)
            assert all(c["hasNativeAuth"] == (c["provider"] == "openai") for c in calls)
            compacted = []
            for rollout in (home / "sessions").rglob("*.jsonl"):
                for line in rollout.read_text().splitlines():
                    item = json.loads(line)
                    if item.get("type") == "compacted":
                        compacted.append(item["payload"])
            assert len(compacted) == 2
            assert all(item.get("message") for item in compacted)
            print(f"start={flow[0]}, tools={tools}: 4 turns + 2 plaintext compactions + restart/resume; {len(calls)} calls; auth isolated; no remote compact or extra handoff call")
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
            if original_tools is not None:
                os.environ["MOCK_TOOL_ROUNDTRIP"] = original_tools
            else:
                os.environ.pop("MOCK_TOOL_ROUNDTRIP", None)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--tools", action="store_true")
    parser.add_argument("--start-opencode", action="store_true")
    args = parser.parse_args()
    run(tools=args.tools, start_opencode=args.start_opencode)
