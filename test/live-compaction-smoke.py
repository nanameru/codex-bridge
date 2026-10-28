import argparse
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4


def main():
    if os.environ.get("RUN_LIVE_ROUTER") != "1":
        raise SystemExit("実際の圧縮履歴をOpenAIで要約し、OpenCodeで応答を確認します。RUN_LIVE_ROUTER=1が必要です")
    parser = argparse.ArgumentParser()
    parser.add_argument("--rollout", type=Path, required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:8791")
    arguments = parser.parse_args()
    history = None
    with arguments.rollout.open() as source:
        for line in source:
            event = json.loads(line)
            if event.get("type") == "compacted":
                history = event["payload"].get("replacement_history")
    if not history or not any(item.get("type") == "compaction" for item in history):
        raise SystemExit("圧縮履歴がありません")
    allowed = {"type", "id", "role", "content", "encrypted_content", "summary", "call_id", "name", "arguments", "output"}
    wire = [{key: value for key, value in item.items() if key in allowed} for item in history]
    wire.append({"type": "message", "role": "user", "content": [{"type": "input_text", "text":
        "This is a connection test. Do not carry out earlier tasks or use tools. Reply exactly COMPACT_OK."}]})
    root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    auth = json.loads(root.joinpath("auth.json").read_text())
    tokens = auth.get("tokens", {})
    if not tokens.get("access_token"):
        raise SystemExit("既存のChatGPTログインが必要です")
    body = {"model": "opencode/deepseek-v4.1-flash", "input": wire, "stream": False, "tools": [],
            "prompt_cache_key": str(uuid4()), "instructions": "Reply COMPACT_OK only. Do not use tools or perform tasks."}
    headers = {"content-type": "application/json", "authorization": "Bearer " + tokens["access_token"],
               "user-agent": "codex_cli_rs/0.163.0", "originator": "codex_cli_rs", "version": "0.163.0"}
    if tokens.get("account_id"):
        headers["chatgpt-account-id"] = tokens["account_id"]
    try:
        with urlopen(Request(arguments.base_url.rstrip("/") + "/v1/responses", data=json.dumps(body).encode(), headers=headers), timeout=180) as response:
            result = json.load(response)
    except HTTPError as error:
        detail = json.loads(error.read()).get("error", {})
        raise SystemExit(f"HTTP {error.code}: {detail.get('type')} {detail.get('message')}") from None
    text = "\n".join(part.get("text", "") for item in result.get("output", [])
                     if item.get("type") == "message" for part in item.get("content", []))
    if "COMPACT_OK" not in text:
        raise SystemExit("正常な実応答を確認できませんでした")
    print("Existing opaque compaction -> OpenAI handoff -> DeepSeek: COMPACT_OK confirmed. Original rollout unchanged.")


if __name__ == "__main__":
    main()
