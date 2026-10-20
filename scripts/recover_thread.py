import argparse
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import time
import tomllib


class LocalServer:
    def __init__(self, binary):
        self.process = subprocess.Popen(
            [binary, "app-server", "--stdio"], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            encoding="utf-8", bufsize=1,
        )
        self.messages = queue.Queue()
        self.sequence = 0
        threading.Thread(target=self.read_messages, daemon=True).start()

    def read_messages(self):
        try:
            for line in self.process.stdout:
                self.messages.put(json.loads(line))
        except (ValueError, OSError):
            pass
        finally:
            self.messages.put(None)

    def send(self, message):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def request(self, method, params):
        self.sequence += 1
        identifier = self.sequence
        self.send({"id": identifier, "method": method, "params": params})
        deadline = time.monotonic() + 60
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(f"ローカル管理操作がタイムアウトしました: {method}")
            try:
                message = self.messages.get(timeout=remaining)
            except queue.Empty:
                raise RuntimeError(f"ローカル管理操作がタイムアウトしました: {method}")
            if message is None:
                raise RuntimeError("ローカル app-server が終了しました")
            if not isinstance(message, dict):
                raise RuntimeError("ローカル app-server の応答形式が不正です")
            if message.get("id") != identifier or "method" in message:
                continue
            if "error" in message:
                error = message["error"]
                detail = error.get("message") if isinstance(error, dict) else None
                raise RuntimeError(detail or "管理操作に失敗しました")
            if "result" not in message:
                raise RuntimeError("ローカル app-server の応答に result がありません")
            return message["result"]

    def close(self):
        try:
            self.process.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        try:
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
        finally:
            self.process.stdout.close()


def thread_from_response(response):
    thread = response.get("thread") if isinstance(response, dict) else None
    if not isinstance(thread, dict) or not isinstance(thread.get("id"), str) or not thread["id"]:
        raise RuntimeError("ローカル app-server の応答に有効な thread がありません")
    return thread


def recover(server, identifier, model):
    server.request("initialize", {
        "clientInfo": {"name": "codex-bridge-recovery", "version": "1.0"},
    })
    server.send({"method": "initialized"})
    original = thread_from_response(server.request(
        "thread/read", {"threadId": identifier, "includeTurns": False},
    ))
    if original.get("modelProvider") != "codex-bridge":
        raise ValueError("このチャットは codex-bridge 接続ではありません")
    if original.get("status", {}).get("type") == "active":
        raise ValueError("元のチャットが実行中です。完了後に復旧してください")
    result = server.request("thread/fork", {
        "threadId": identifier, "model": model, "modelProvider": "openai",
        "excludeTurns": True,
    })
    restored = thread_from_response(result)
    if (result.get("modelProvider") != "openai"
            or restored.get("modelProvider") != "openai"
            or result.get("model") != model
            or restored["id"] == identifier):
        raise RuntimeError("復旧結果の接続先を確認できません。会話の送信は行っていません")
    name = "通常Codexで再開: " + (original.get("name") or original.get("preview") or "会話")[:60]
    server.request("thread/name/set", {"threadId": restored["id"], "name": name})
    return {"threadId": restored["id"], "model": result["model"],
            "modelProvider": result["modelProvider"], "name": name}


def main():
    parser = argparse.ArgumentParser(description="履歴を引き継ぎ通常Codexへ分岐します。元の会話は保持します。")
    parser.add_argument("thread_id")
    parser.add_argument("--model")
    parser.add_argument("--codex", default="codex")
    arguments = parser.parse_args()
    root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser()
    data = tomllib.loads((root / "config.toml").read_text())
    if data.get("model_provider", "openai") != "openai":
        raise ValueError("先に switch.sh off で既定の接続先を通常Codexへ戻してください")
    model = arguments.model or data.get("model")
    if not isinstance(model, str) or not (
        model.startswith(("gpt-", "codex-")) or re.fullmatch(r"o[0-9]+(?:[-.][A-Za-z0-9_.-]+)?", model)
    ):
        raise ValueError("通常Codexのモデルを --model で指定してください")
    server = LocalServer(arguments.codex)
    try:
        result = recover(server, arguments.thread_id, model)
    finally:
        server.close()
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(f"復旧できません: {error}")
