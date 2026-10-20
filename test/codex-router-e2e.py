import base64
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from recover_thread import LocalServer
from unified_config import prepare


def fake_auth():
    def encoded(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
    claims = {"sub": "test-user", "exp": int(time.time()) + 3600,
              "https://api.openai.com/auth": {"chatgpt_account_id": "test-account", "chatgpt_plan_type": "pro"}}
    token = encoded({"alg": "none"}) + "." + encoded(claims) + ".test-only"
    return {"auth_mode": "chatgpt", "tokens": {"id_token": token, "access_token": token,
            "refresh_token": "test-refresh-unused", "account_id": "test-account"},
            "last_refresh": datetime.now(timezone.utc).isoformat()}


def complete_turn(server, thread, model):
    result = server.request("turn/start", {"threadId": thread, "model": model,
                            "input": [{"type": "text", "text": "Reply OK only. Do not use tools."}]})
    turn_id = result["turn"]["id"]
    deadline = time.monotonic() + 30
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("turn completion timed out")
        message = server.messages.get(timeout=remaining)
        if message is None:
            raise RuntimeError("app-server exited")
        turn = message.get("params", {}).get("turn", {})
        if message.get("method") == "turn/completed" and turn.get("id") == turn_id:
            assert turn["status"] == "completed", turn.get("error")
            return


def run():
    original_home = os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))
    with tempfile.TemporaryDirectory(prefix="codex-unified-e2e-") as directory:
        home = Path(directory)
        for filename in ["models_cache.json", "model-catalog.json"]:
            home.joinpath(filename).write_bytes(Path(original_home, filename).read_bytes())
        prepare(home, ROOT)
        home.joinpath("auth.json").write_text(json.dumps(fake_auth()))
        home.joinpath("auth.json").chmod(0o600)
        environment = {**os.environ, "CODEX_HOME": directory}
        upstream = subprocess.Popen(["node", str(ROOT / "test/mock-unified.mjs")], env=environment,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    text=True, bufsize=1)
        server = None
        os.environ["CODEX_HOME"] = directory
        try:
            base = json.loads(upstream.stdout.readline())["url"]
            home.joinpath("config.toml").write_text(
                'model="gpt-6.1-sol"\nopenai_base_url=' + json.dumps(base)
                + '\nmodel_catalog_json=' + json.dumps(str(home / "unified-model-catalog.json"))
                + '\n[model_providers.codex-bridge]\nname="mock"\nwire_api="responses"\nrequires_openai_auth=true\nbase_url=' + json.dumps(base) + '\n'
            )
            server = LocalServer(os.environ.get("CODEX_BIN", "codex"))
            server.request("initialize", {"clientInfo": {"name": "unified-e2e", "version": "1"}})
            server.send({"method": "initialized"})
            saved = []
            for provider, models in [
                ("openai", ["gpt-6.1-sol", "opencode/deepseek-v4.1-flash", "gpt-6.1-sol"]),
                ("codex-bridge", ["opencode/deepseek-v4.1-flash", "gpt-6.1-sol", "opencode/deepseek-v4.1-flash"]),
            ]:
                thread = server.request("thread/start", {"cwd": directory, "model": models[0], "modelProvider": provider})["thread"]["id"]
                for model in models:
                    complete_turn(server, thread, model)
                history = server.request("thread/read", {"threadId": thread, "includeTurns": True})["thread"]
                assert history["id"] == thread
                assert len(history["turns"]) == 3
                saved.append((thread, provider))
                print(provider + ": same thread, 3 completed turns")
            server.close()
            server = LocalServer(os.environ.get("CODEX_BIN", "codex"))
            server.request("initialize", {"clientInfo": {"name": "unified-e2e-resume", "version": "1"}})
            server.send({"method": "initialized"})
            for thread, provider in saved:
                resumed = server.request("thread/resume", {"threadId": thread, "excludeTurns": True})
                assert resumed["thread"]["id"] == thread
                assert resumed["modelProvider"] == provider
                model = "opencode/deepseek-v4.1-flash" if provider == "openai" else "gpt-6.1-sol"
                complete_turn(server, thread, model)
                history = server.request("thread/read", {"threadId": thread, "includeTurns": True})["thread"]
                assert len(history["turns"]) == 4
            print("both persisted threads resumed with the same IDs and switched providers")
            upstream.stdin.write("summary\n")
            upstream.stdin.flush()
            calls = json.loads(upstream.stdout.readline())["calls"]
            assert len(calls) == 8
            assert [call["provider"] for call in calls] == ["openai", "opencode", "openai", "opencode", "openai", "opencode", "opencode", "openai"]
            for call in calls:
                assert not call["previousResponse"]
                assert call["hasNativeAuth"] == (call["provider"] == "openai")
                assert all(provider == call["provider"] for provider in call["reasoningProviders"])
            for start in [0, 3]:
                assert calls[start]["inputItems"] < calls[start + 1]["inputItems"] < calls[start + 2]["inputItems"]
            print("8 mock turns passed; auth isolation, history and persisted resume verified")
        finally:
            if server:
                server.close()
            upstream.stdin.close()
            try:
                upstream.wait(timeout=5)
            except subprocess.TimeoutExpired:
                upstream.terminate()
                upstream.wait(timeout=5)
            os.environ["CODEX_HOME"] = original_home


if __name__ == "__main__":
    run()
