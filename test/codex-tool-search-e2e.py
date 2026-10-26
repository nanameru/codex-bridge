"""Real Codex + synthetic MCP + scripted local model; no inference API calls."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def run(lite=False, code_mode=False):
    source = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
    with tempfile.TemporaryDirectory(prefix='codex-tool-search-home-') as directory, \
            tempfile.TemporaryDirectory(prefix='codex-tool-search-work-') as cwd:
        home = Path(directory)
        native = json.loads((source / 'models_cache.json').read_text())
        template = next(m for m in native['models'] if m.get('slug') == 'gpt-6.1-sol')
        model = {**template, 'slug': 'opencode/deepseek-v4.1-flash', 'display_name': 'Synthetic tool search probe',
                 'tool_mode': 'code_mode_only' if code_mode else None, 'supports_search_tool': True, 'use_responses_lite': lite, 'router_provider': 'opencode',
                 'router_model': 'glm-5.3-flash', 'router_transport': 'chat'}
        (home / 'bridge-local-token').write_text('a' * 64)
        (home / 'bridge-local-token').chmod(0o600)
        (home / 'catalog.json').write_text(json.dumps({'models': [model]}))
        env = {key: value for key, value in os.environ.items() if key in {'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'}}
        env.update(CODEX_HOME=directory, HOME=directory, SYNTHETIC_MODEL_KEY='synthetic-key', SYNTHETIC_CODE_MODE='1' if code_mode else '0')
        upstream = subprocess.Popen(['node', str(ROOT / 'test/mock-tool-search-bridge.mjs')], env=env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, bufsize=1)
        try:
            base = json.loads(upstream.stdout.readline())['url']
            config = ('model="opencode/deepseek-v4.1-flash"\nmodel_provider="codex-bridge"\nweb_search="disabled"\n'
                      + 'model_catalog_json=' + json.dumps(str(home / 'catalog.json')) + '\n'
                      + '[model_providers.codex-bridge]\nname="Synthetic local model"\nwire_api="responses"\n'
                      + 'requires_openai_auth=false\nenv_key="SYNTHETIC_MODEL_KEY"\nrequest_max_retries=0\nstream_max_retries=0\nbase_url=' + json.dumps(base) + '\n'
                      + '[mcp_servers.synthetic]\ncommand=' + json.dumps(sys.executable) + '\n'
                      + 'args=' + json.dumps([str(ROOT / 'test/mock-tool-search-mcp.py')]) + '\n'
                      + '[mcp_servers.synthetic.env]\nSYNTHETIC_MCP_RECEIPT=' + json.dumps(str(home / 'mcp-receipt.jsonl')) + '\n')
            if code_mode:
                config += '\n[features]\ncode_mode_tool_search=true\n'
            (home / 'config.toml').write_text(config)
            result = subprocess.run([os.environ.get('CODEX_BIN', 'codex'), 'exec', '--json', '--skip-git-repo-check',
                                     '--sandbox', 'read-only', 'Discover and call needle_target from synthetic MCP, then report its verification marker.'],
                                    cwd=cwd, env=env, capture_output=True, text=True, timeout=60)
            upstream.stdin.write('metrics\n')
            upstream.stdin.flush()
            calls = json.loads(upstream.stdout.readline())['calls']
            events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
            completed = [event['item'] for event in events if event.get('type') == 'item.completed'
                         and event.get('item', {}).get('type') == 'mcp_tool_call']
            messages = [event['item'] for event in events if event.get('type') == 'item.completed'
                        and event.get('item', {}).get('type') == 'agent_message']
            turns = [event for event in events if event.get('type') == 'turn.completed']
            receipt = home / 'mcp-receipt.jsonl'
            executed = [json.loads(line) for line in receipt.read_text().splitlines()] if receipt.exists() else []
            if result.returncode != 0 or len(turns) != 1:
                print(json.dumps({'exit_code': result.returncode, 'stderr': result.stderr[-1500:], 'events': events, 'calls': calls}, ensure_ascii=False))
            assert result.returncode == 0 and len(turns) == 1, 'Codex fixture did not complete'
            assert len(completed) == 1 and completed[0]['status'] == 'completed' and completed[0].get('error') is None, 'MCP tool did not execute'
            assert executed == [{'name': 'needle_target'}], 'MCP tool execution receipt missing or duplicated'
            assert len(messages) == 1 and messages[0]['text'] == 'NEEDLE_TARGET_OK', 'Final model did not receive the tool result'
            assert len(calls) == 3, 'Expected search, target call and final response requests'
            assert (code_mode or calls[0]['hasSearch']) and not calls[0]['hasTarget'], 'MCP target schema was not deferred'
            assert code_mode or all(call['hasSearch'] and call['hasTarget'] for call in calls[1:]), 'Search result schema was not retained'
            assert code_mode or calls[1]['toolsCount'] == calls[0]['toolsCount'] + 1, 'Only the discovered MCP schema should load'
            if code_mode:
                assert calls[1]['searchResultNames'] == ['mcp__synthetic__needle_target'], 'Code Mode search did not return the target declaration'
            assert calls[0]['toolsCount'] < 30 and calls[0]['toolsBytes'] < 30000, 'Unrelated MCP schemas were eagerly exposed'
            assert all(call['includeUsage'] for call in calls), 'Bridge did not request streaming usage'
            assert turns[0]['usage']['input_tokens'] == 300 and turns[0]['usage']['cached_input_tokens'] == 180, 'Usage input/cache details were lost'
            assert turns[0]['usage']['reasoning_output_tokens'] == 6, 'Usage reasoning details were lost'
            print(json.dumps({'lite': lite, 'code_mode': code_mode, 'exit_code': result.returncode, 'synthetic_mcp_tools': 129,
                              'requests': len(calls), 'mcp_calls': len(executed),
                              'initial_tools_count': calls[0]['toolsCount'], 'initial_tools_bytes': calls[0]['toolsBytes'],
                              'discovered_tools_count': calls[1]['toolsCount'], 'discovered_tools_bytes': calls[1]['toolsBytes'],
                              'usage': turns[0]['usage'], 'search_result_names': calls[1].get('searchResultNames') if code_mode else None}, ensure_ascii=False))
        finally:
            upstream.stdin.close()
            try:
                upstream.wait(timeout=5)
            except subprocess.TimeoutExpired:
                upstream.terminate()
                upstream.wait(timeout=5)
            upstream.stdout.close()
            upstream.stderr.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Validate deferred MCP discovery through the local Chat bridge')
    parser.add_argument('--lite', action='store_true', help='Exercise Codex Responses Lite additional_tools')
    parser.add_argument('--code-mode', action='store_true', help='Exercise isolated Code Mode ranked tool search')
    args = parser.parse_args()
    run(lite=args.lite, code_mode=args.code_mode)
