from contextlib import contextmanager
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from urllib.request import urlopen
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from recover_thread import LocalServer


@contextmanager
def isolated_login(comparison=False):
    base = os.environ.get("LIVE_ROUTER_BASE_URL", "http://127.0.0.1:8791/v1")
    parsed = urlparse(base)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.path != "/v1" or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("実応答テストの接続先はloopback HTTP /v1に限定します")
    previous = os.environ.get("CODEX_HOME")
    source = Path(previous) if previous else Path.home() / ".codex"
    with tempfile.TemporaryDirectory(prefix="codex-live-smoke-") as directory:
        root = Path(directory)
        for name in ["auth.json", "unified-model-catalog.json", "models_cache.json"]:
            if not (source / name).exists():
                if name == "models_cache.json":
                    continue
                raise SystemExit("既存のログインと統合カタログが必要です: " + name)
            destination = root / name
            destination.write_bytes((source / name).read_bytes())
            destination.chmod(0o600)
        if comparison and (source / "AGENTS.md").exists():
            (root / "AGENTS.md").write_bytes((source / "AGENTS.md").read_bytes())
            (root / "AGENTS.md").chmod(0o600)
        if comparison:
            catalog = json.loads((root / "unified-model-catalog.json").read_text())
            models = {model["slug"]: model for model in catalog["models"]}
            if ("gpt-6.1-sol" not in models or models.get("opencode/deepseek-v4.1-flash", {}).get("router_transport") != "responses"):
                raise ValueError("比較にはGPTと公式Responses対応DeepSeekの統合カタログが必要です")
        config = ('model="gpt-6.1-sol"\nopenai_base_url=' + json.dumps(base) + '\n'
                  + 'model_catalog_json=' + json.dumps(str(root / "unified-model-catalog.json"))
                  + '\n[model_providers.codex-bridge]\nname="live-smoke"\nwire_api="responses"\n'
                  + 'requires_openai_auth=true\nbase_url=' + json.dumps(base) + '\n')
        if comparison:
            config = 'model_provider="codex-bridge"\n' + config
            config += 'request_max_retries=0\nstream_max_retries=0\n'
            config += '[model_providers.codex-bridge.http_headers]\nx-codex-bridge-direct="1"\n'
        (root / "config.toml").write_text(config)
        (root / "config.toml").chmod(0o600)
        os.environ["CODEX_HOME"] = directory
        try:
            yield
        finally:
            if previous is None:
                os.environ.pop("CODEX_HOME", None)
            else:
                os.environ["CODEX_HOME"] = previous


def compare_latency(server, cwd, gpt_first=False):
    models = ["opencode/deepseek-v4.1-flash", "gpt-6.1-sol"]
    if gpt_first:
        models.reverse()
    server.request("initialize", {"clientInfo": {"name": "unified-latency-check", "version": "1"}})
    server.send({"method": "initialized"})
    for repetition in range(1, 3):
        for model in models:
            thread = server.request("thread/start", {
                "cwd": cwd, "model": model, "modelProvider": "codex-bridge",
                "ephemeral": True, "sandbox": "read-only", "approvalPolicy": "never",
            })["thread"]["id"]
            started = time.monotonic()
            result = server.request("turn/start", {
                "threadId": thread, "model": model, "effort": "low",
                "input": [{"type": "text", "text": "こんにちは！"}],
            })
            turn_id = result["turn"]["id"]
            first_text_ms = None
            usage = None
            tool_calls = 0
            deadline = started + 90
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError("比較ターンがタイムアウトしました")
                message = server.messages.get(timeout=remaining)
                if message is None:
                    raise RuntimeError("比較用app-serverが終了しました")
                params = message.get("params", {})
                if params.get("threadId") != thread:
                    continue
                method = message.get("method")
                if method == "item/agentMessage/delta" and params.get("delta") and first_text_ms is None:
                    first_text_ms = round((time.monotonic() - started) * 1000)
                if method == "thread/tokenUsage/updated":
                    last = params.get("tokenUsage", {}).get("last", {})
                    usage = {name: last[name] for name in (
                        "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens")
                        if isinstance(last.get(name), int) and not isinstance(last[name], bool)}
                if method == "item/completed" and params.get("item", {}).get("type") in (
                        "commandExecution", "mcpToolCall", "dynamicToolCall", "webSearch", "fileChange"):
                    tool_calls += 1
                turn = params.get("turn", {})
                if method == "turn/completed" and turn.get("id") == turn_id:
                    if turn.get("status") != "completed" or first_text_ms is None:
                        raise RuntimeError("比較ターンの正常応答を確認できません: " + model)
                    print(json.dumps({"model": model, "repetition": repetition, "effort": "low",
                                      "first_text_ms": first_text_ms,
                                      "total_ms": round((time.monotonic() - started) * 1000),
                                      "tool_calls": tool_calls, "usage": usage}, ensure_ascii=False), flush=True)
                    if tool_calls:
                        raise RuntimeError("ツール実行があり同条件の挨拶比較になりません。測定を停止します")
                    break


def run_checks():
    ready = False
    for _attempt in range(30):
        try:
            with urlopen("http://127.0.0.1:8791/health", timeout=1) as response:
                ready = json.load(response).get("mode") == "unified"
            if ready:
                break
        except OSError:
            pass
        time.sleep(0.2)
    if not ready:
        raise RuntimeError("共通routerが起動していません")
    server = LocalServer(os.environ.get("CODEX_BIN", "codex"))
    tool_mode = os.environ.get("LIVE_ROUTER_TOOLS") == "1"
    prompt = ("Use exec_command exactly twice, one call at a time, to run printf ROUTE_OK1 then printf ROUTE_OK2. "
              "Check each result before the next call, then reply exactly ROUTE_OK. Do not read files or use other tools."
              if tool_mode else "Reply exactly ROUTE_OK. Do not use tools.")
    try:
        server.request("initialize", {"clientInfo": {"name": "unified-live-smoke", "version": "1"}})
        server.send({"method": "initialized"})
        thread = server.request("thread/start", {
            "cwd": "/tmp", "model": "opencode/deepseek-v4.1-flash", "modelProvider": "codex-bridge",
            "ephemeral": True, "sandbox": "read-only", "approvalPolicy": "never",
            "baseInstructions": prompt,
        })["thread"]["id"]
        for model in ["opencode/deepseek-v4.1-flash", "gpt-6.1-sol", "opencode/deepseek-v4.1-flash"]:
            result = server.request("turn/start", {"threadId": thread, "model": model, "effort": "low",
                                                    "input": [{"type": "text", "text": prompt}]})
            turn_id = result["turn"]["id"]
            deadline = time.monotonic() + 90
            text = ""
            commands = 0
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError("turn completion timed out")
                message = server.messages.get(timeout=remaining)
                if message is None:
                    raise RuntimeError("app-server exited")
                if message.get("method") == "item/agentMessage/delta":
                    text += message["params"].get("delta", "")
                if message.get("method") == "item/completed" and message.get("params", {}).get("item", {}).get("type") == "commandExecution":
                    commands += 1
                turn = message.get("params", {}).get("turn", {})
                if message.get("method") == "turn/completed" and turn.get("id") == turn_id:
                    if turn["status"] != "completed" or "ROUTE_OK" not in text:
                        raise RuntimeError("モデルの正常な実応答を確認できません: " + model
                                           + " " + json.dumps(turn.get("error"), ensure_ascii=False))
                    if tool_mode and commands != 2:
                        raise RuntimeError("2回のツール往復を確認できません: " + model)
                    print(model + f": ROUTE_OK confirmed on same thread, {commands} commands", flush=True)
                    break
    finally:
        server.close()


def main():
    comparison = os.environ.get("LIVE_ROUTER_COMPARE") == "1"
    if os.environ.get("RUN_LIVE_ROUTER") != "1":
        count = 4 if comparison else 3
        raise SystemExit(f"実モデルを{count}回呼び出します。実行する場合はRUN_LIVE_ROUTER=1を指定してください")
    with isolated_login(comparison=comparison):
        if comparison:
            base = os.environ.get("LIVE_ROUTER_BASE_URL", "http://127.0.0.1:8791/v1")
            with urlopen(base[:-3] + "/health", timeout=3) as response:
                health = json.load(response)
            if "opencode/deepseek-v4.1-flash" not in health.get("direct_models", []):
                raise RuntimeError("routerがDeepSeekの公式Responses接続に対応していません")
            with tempfile.TemporaryDirectory(prefix="codex-comparison-work-") as cwd:
                server = LocalServer(os.environ.get("CODEX_BIN", "codex"))
                try:
                    compare_latency(server, cwd, gpt_first=os.environ.get("LIVE_ROUTER_GPT_FIRST") == "1")
                finally:
                    server.close()
        else:
            run_checks()


if __name__ == "__main__":
    main()
