import json
import os
from pathlib import Path
import sys
import time
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from recover_thread import LocalServer


def main():
    if os.environ.get("RUN_LIVE_ROUTER") != "1":
        raise SystemExit("実モデルを3回呼び出します。実行する場合はRUN_LIVE_ROUTER=1を指定してください")
    ready = False
    for _attempt in range(30):
        try:
            with urlopen("http://127.0.0.1:8790/health", timeout=1) as response:
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
                        raise RuntimeError("モデルの正常な実応答を確認できません: " + model)
                    if tool_mode and commands != 2:
                        raise RuntimeError("2回のツール往復を確認できません: " + model)
                    print(model + f": ROUTE_OK confirmed on same thread, {commands} commands", flush=True)
                    break
    finally:
        server.close()


if __name__ == "__main__":
    main()
