import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from unified_config import configure_flash_code_mode as configure_code_mode
SPEC = importlib.util.spec_from_file_location("router_e2e", ROOT / "test/codex-router-e2e.py")
ROUTER_E2E = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ROUTER_E2E)
MODEL = "opencode/deepseek-v4.1-flash"


def run(live=False):
    source = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    with tempfile.TemporaryDirectory(prefix="codex-code-mode-home-") as directory, \
            tempfile.TemporaryDirectory(prefix="codex-code-mode-work-") as cwd:
        home = Path(directory)
        for name in ["models_cache.json", "AGENTS.md"]:
            if (source / name).exists():
                shutil.copyfile(source / name, home / name)
                (home / name).chmod(0o600)
        catalog = json.loads((source / "unified-model-catalog.json").read_text())
        configure_code_mode(catalog)
        (home / "unified-model-catalog.json").write_text(json.dumps(catalog))
        (home / "auth.json").write_text(json.dumps(ROUTER_E2E.fake_auth()))
        (home / "auth.json").chmod(0o600)
        environment = {**os.environ, "CODEX_HOME": directory, "MOCK_DIRECT_RESPONSES": "1", "MOCK_CODE_MODE": "1"}
        if live:
            server_source = """
import { readFileSync } from 'node:fs';
import { createRouter } from './src/model-router.mjs';
const catalog = JSON.parse(readFileSync(process.env.CODEX_HOME + '/unified-model-catalog.json'));
const metrics = [];
let requests = 0;
const server = createRouter({catalog, fetcher: (...args) => {
  if (++requests > 2) throw new Error('Live probe request limit');
  return fetch(...args);
}, onMetric: metric => metrics.push(metric)});
server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({url: 'http://127.0.0.1:' + server.address().port + '/v1'}) + '\\n'));
process.stdin.on('data', () => process.stdout.write(JSON.stringify({calls: metrics}) + '\\n'));
process.stdin.on('end', () => { server.closeAllConnections(); server.close(); });
"""
            command = ["node", "--input-type=module", "-e", server_source]
        else:
            command = ["node", str(ROOT / "test/mock-unified.mjs")]
        upstream = subprocess.Popen(command, cwd=ROOT, env=environment, stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, text=True)
        try:
            base = json.loads(upstream.stdout.readline())["url"]
            config = ('model=' + json.dumps(MODEL) + '\nmodel_provider="codex-bridge"\nmodel_reasoning_effort="low"\n'
                      + 'model_catalog_json=' + json.dumps(str(home / "unified-model-catalog.json"))
                      + '\n[model_providers.codex-bridge]\nname="Code mode probe"\nwire_api="responses"\n'
                      + 'requires_openai_auth=true\nrequest_max_retries=0\nstream_max_retries=0\nbase_url=' + json.dumps(base)
                      + '\n[model_providers.codex-bridge.http_headers]\nx-codex-bridge-direct="1"\n')
            (home / "config.toml").write_text(config)
            started = time.monotonic()
            result = subprocess.run([os.environ.get("CODEX_BIN", "codex"), "exec", "--json",
                                     "--skip-git-repo-check", "--sandbox", "read-only",
                                     "Run printf CODE_MODE_OK once, then report its output."],
                                    cwd=cwd, env=environment, capture_output=True, text=True, timeout=90)
            events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
            commands = [event["item"] for event in events if event.get("type") == "item.completed"
                        and event.get("item", {}).get("type") == "command_execution"]
            upstream.stdin.write("metrics\n")
            upstream.stdin.flush()
            calls = json.loads(upstream.stdout.readline())["calls"]
            completed = sum(event.get("type") == "turn.completed" for event in events)
            report = {"live": live, "exit_code": result.returncode, "seconds": round(time.monotonic() - started, 3),
                      "commands": len(commands), "completed": completed,
                      "metrics": [{name: call.get(name) for name in (
                          "toolsCount", "toolsBytes", "toolTypes", "requestBytes", "codeModeOutput",
                          "tools_count", "tools_bytes", "forwarded_bytes", "upstream_status", "total_ms")}
                                  for call in calls]}
            print(json.dumps(report, ensure_ascii=False))
            assert result.returncode == 0 and completed == 1 and len(commands) == 1, "コードモードの実行を確認できません"
            assert commands[0].get("exit_code") == 0 and "CODE_MODE_OK" in commands[0].get("aggregated_output", "")
            assert len(calls) == 2 and (live or calls[-1]["codeModeOutput"]), "ツール結果の返送を確認できません"
        finally:
            upstream.stdin.close()
            upstream.wait(timeout=10)
            upstream.stdout.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="隔離したFlashで標準コードモードを検証する")
    parser.add_argument("--live", action="store_true")
    arguments = parser.parse_args()
    if arguments.live and os.environ.get("RUN_LIVE_CODE_MODE") != "1":
        parser.error("実APIを最大2回呼びます。RUN_LIVE_CODE_MODE=1を指定してください")
    run(live=arguments.live)
