"""Issue #186: real Codex app-server + fake upstreams where OpenAI compaction hits its usage limit.

The selected model writes the compaction. Codex must keep the router-owned item
and send it back, the router must unwrap it, and the conversation must continue
(including after a second compaction and a resume).
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from unified_config import prepare

spec = importlib.util.spec_from_file_location("handoff_app", ROOT / "test/handoff-app-e2e.py")
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)
e2e = app.e2e

MODEL = "opencode/deepseek-v4.1-flash"


def answered(messages, text):
    return any(text in m.get("params", {}).get("delta", "") for m in messages
               if m.get("method") == "item/agentMessage/delta")


def run(mode="selected"):
    original = os.environ.get("CODEX_HOME")
    source = Path(original or Path.home() / ".codex")
    with tempfile.TemporaryDirectory(prefix="codex-selected-compaction-") as directory:
        home = Path(directory)
        for filename in ["models_cache.json", "model-catalog.json"]:
            (home / filename).write_bytes((source / filename).read_bytes())
        prepare(home, ROOT)
        (home / "auth.json").write_text(json.dumps(e2e.fake_auth()))
        (home / "auth.json").chmod(0o600)
        env = {**os.environ, "CODEX_HOME": directory, "MOCK_HISTORY_MODE": mode}
        upstream = subprocess.Popen(["node", str(ROOT / "test/mock-selected-compaction.mjs")], env=env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        server = None
        try:
            base = json.loads(upstream.stdout.readline())["url"]
            (home / "config.toml").write_text('model=' + json.dumps(MODEL) + '\nmodel_provider="openai"\n'
                                             'openai_base_url=' + json.dumps(base) + '\nmodel_catalog_json='
                                             + json.dumps(str(home / "unified-model-catalog.json")) + '\n')
            os.environ["CODEX_HOME"] = directory
            binary = os.environ.get("CODEX_BIN", "codex")
            server = app.start(binary)
            info = server.request("thread/start", {"cwd": directory, "sandbox": "read-only", "approvalPolicy": "never"})
            thread = info["thread"]["id"]
            first, status = app.turn(server, thread, MODEL)
            assert status == "completed" and answered(first, "opencode_OK"), status
            app.compact(server, thread)  # OpenAI 429 -> selected model writes the compaction
            after, status = app.turn(server, thread, None)
            assert status == "completed" and answered(after, "opencode_OK"), status
            app.compact(server, thread)  # inside the limit window: OpenAI is not asked
            later, status = app.turn(server, thread, None)
            assert status == "completed" and answered(later, "opencode_OK"), status
            server.close()
            server = app.start(binary)
            resumed = server.request("thread/resume", {"threadId": thread, "excludeTurns": True})
            assert resumed["thread"]["id"] == thread
            final, status = app.turn(server, thread, None)
            assert status == "completed" and answered(final, "opencode_OK"), status

            upstream.stdin.write("report\n")
            upstream.stdin.flush()
            report = json.loads(upstream.stdout.readline())
            calls, metrics = report["calls"], report["metrics"]
            compactions = [m for m in metrics if m.get("remote_compaction_fallback")]
            assert [m.get("remote_compaction_fallback") for m in compactions] == ["selected", "selected"], compactions
            assert compactions[0].get("remote_compaction_openai_status") == 429, compactions
            assert compactions[1].get("remote_compaction_openai_skipped") is True, compactions
            assert all(m["status"] == 200 for m in compactions), compactions
            openai_compactions = [c for c in calls if c["provider"] == "openai" and c["compactionTrigger"]]
            assert len(openai_compactions) == 1, calls  # AC-04: the second compaction skipped OpenAI
            summaries = [c for c in calls if c["summary"]]
            assert len(summaries) == 2 and all(c["provider"] == "opencode" for c in summaries), calls
            assert not any(c["hasNativeAuth"] for c in calls if c["provider"] == "opencode"), calls
            # Codex sent the router-owned item back; the router unwrapped it.
            restored = [m for m in metrics if m.get("selected_compaction_restored")]
            assert len(restored) >= 3, metrics
            turns = [c for c in calls if c["provider"] == "opencode" and not c["summary"]]
            assert all(c["hasSelectedSummary"] for c in turns[1:]), turns
            assert not any(c["hasRouterWrapper"] for c in calls), calls
            assert not any("compaction" in (c["inputTypes"] or []) for c in calls), calls
            assert not any(c["compactionTrigger"] for c in calls if c["provider"] == "opencode"), calls
            print(f"Codex app-server ({mode}): OpenAI 429 -> selected-model compaction x2 (2nd skipped OpenAI); "
                  f"item returned by Codex and unwrapped {len(restored)}x; turns continue after resume; "
                  f"calls={len(calls)}")
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
    run(mode=sys.argv[1] if len(sys.argv) > 1 else "selected")
