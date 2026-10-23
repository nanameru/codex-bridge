"""Actual Codex: live model discovery, TTL refresh, native compaction and resume."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from live_catalog import candidate
from unified_config import prepare

spec = importlib.util.spec_from_file_location("handoff", ROOT / "test/handoff-app-e2e.py")
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


def run():
    original = os.environ.get("CODEX_HOME")
    source = Path(original or Path.home() / ".codex")
    with tempfile.TemporaryDirectory(prefix="codex-live-catalog-") as directory:
        home = Path(directory)
        for name in ["models_cache.json", "model-catalog.json"]:
            (home / name).write_bytes((source / name).read_bytes())
        prepare(home, ROOT)
        (home / "auth.json").write_text(json.dumps(h.e2e.fake_auth()))
        (home / "auth.json").chmod(0o600)
        env = {**os.environ, "CODEX_HOME": directory, "MOCK_LIVE_CATALOG": "1"}
        upstream = subprocess.Popen(["node", str(ROOT / "test/mock-handoff.mjs")], env=env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        server = None
        try:
            base = json.loads(upstream.stdout.readline())["url"]
            port = int(base.split(":")[-1].split("/")[0])
            (home / "config.toml").write_text(candidate('model="gpt-6.1-sol"\nmodel_provider="openai"\n', port))
            os.environ["CODEX_HOME"] = directory
            server = h.start(os.environ.get("CODEX_BIN", "codex"))
            first = server.request("model/list", {"limit": 100})["data"]
            assert any(m["model"] == "opencode/deepseek-v4.1-flash" for m in first)
            assert not any(m["model"] == "opencode/future-test" for m in first)
            upstream.stdin.write("advance\n"); upstream.stdin.flush()
            assert json.loads(upstream.stdout.readline())["advanced"]
            # Advance only the isolated client's cache TTL; no real five-minute wait.
            path = home / "models_cache.json"
            cache = json.loads(path.read_text()); cache["fetched_at"] = "2020-01-01T00:00:00Z"
            path.write_text(json.dumps(cache))
            second = server.request("model/list", {"limit": 100})["data"]
            assert any(m["model"] == "opencode/future-test" for m in second), [m["model"] for m in second]
            thread = server.request("thread/start", {"cwd": directory, "sandbox": "read-only", "approvalPolicy": "never"})["thread"]["id"]
            assert h.turn(server, thread, "gpt-6.1-sol")[1] == "completed"
            h.compact(server, thread)
            assert h.turn(server, thread, "opencode/future-test")[1] == "completed"
            h.compact(server, thread)
            server.close(); server = h.start(os.environ.get("CODEX_BIN", "codex"))
            assert server.request("thread/resume", {"threadId": thread, "excludeTurns": True})["thread"]["id"] == thread
            assert h.turn(server, thread, "gpt-6.1-sol")[1] == "completed"
            print("actual app-server: live discovery -> same-process TTL addition -> new model answer -> native compaction -> resume passed")
        finally:
            if server: server.close()
            upstream.stdin.close()
            try: upstream.wait(timeout=5)
            except subprocess.TimeoutExpired: upstream.terminate(); upstream.wait(timeout=5)
            if original is None: os.environ.pop("CODEX_HOME", None)
            else: os.environ["CODEX_HOME"] = original


if __name__ == "__main__":
    run()
