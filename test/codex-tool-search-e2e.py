"""Real Codex + synthetic MCP + scripted local model; no inference API calls."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PROMPT = 'Discover and call needle_target from synthetic MCP, then report its verification marker.'


def run(lite=False, code_mode=False, history_evolution=False):
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
        env.update(CODEX_HOME=directory, HOME=directory, SYNTHETIC_MODEL_KEY='synthetic-key',
                   SYNTHETIC_CODE_MODE='1' if code_mode else '0', SYNTHETIC_HISTORY_EVOLUTION='1' if history_evolution else '0')
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
                      + '[mcp_servers.synthetic.env]\nSYNTHETIC_MCP_RECEIPT=' + json.dumps(str(home / 'mcp-receipt.jsonl')) + '\n'
                      + 'SYNTHETIC_MCP_SCHEMA_VERSION="1"\n')
            if code_mode:
                config += '\n[features]\ncode_mode_tool_search=true\n'
            (home / 'config.toml').write_text(config)
            binary = os.environ.get('CODEX_BIN', 'codex')
            invocation_timeout = 40 if history_evolution else 60
            command = [binary, 'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only']
            results = [subprocess.run([*command, PROMPT], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                      capture_output=True, text=True, timeout=invocation_timeout)]
            first_events = [json.loads(line) for line in results[0].stdout.splitlines() if line.startswith('{')]
            session = next((event['thread_id'] for event in first_events if event.get('type') == 'thread.started'), None)
            if history_evolution:
                assert results[0].returncode == 0 and session, 'First turn must complete before replay'
                (home / 'config.toml').write_text(config.replace('SYNTHETIC_MCP_SCHEMA_VERSION="1"', 'SYNTHETIC_MCP_SCHEMA_VERSION="2"'))
                results.append(subprocess.run([*command, 'resume', session, PROMPT], cwd=cwd, env=env,
                                              stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=invocation_timeout))
            upstream.stdin.write('metrics\n')
            upstream.stdin.flush()
            calls = json.loads(upstream.stdout.readline())['calls']
            events = [json.loads(line) for result in results for line in result.stdout.splitlines() if line.startswith('{')]
            completed = [event['item'] for event in events if event.get('type') == 'item.completed'
                         and event.get('item', {}).get('type') == 'mcp_tool_call']
            messages = [event['item'] for event in events if event.get('type') == 'item.completed'
                        and event.get('item', {}).get('type') == 'agent_message']
            turns = [event for event in events if event.get('type') == 'turn.completed']
            receipt = home / 'mcp-receipt.jsonl'
            executed = [json.loads(line) for line in receipt.read_text().splitlines()] if receipt.exists() else []
            expected_turns = 2 if history_evolution else 1
            if any(result.returncode != 0 for result in results) or len(turns) != expected_turns:
                print(json.dumps({'exit_codes': [result.returncode for result in results],
                                  'events': events, 'calls': calls}, ensure_ascii=False))
            assert all(result.returncode == 0 for result in results) and len(turns) == expected_turns, 'Codex fixture did not complete'
            assert all(event.get('thread_id') == session for event in events if event.get('type') == 'thread.started'), 'Resume changed the saved thread ID'
            assert len(completed) == expected_turns and all(item['status'] == 'completed' and item.get('error') is None for item in completed), 'MCP tool did not execute'
            assert executed == [{'name': 'needle_target', 'schema_version': version} for version in range(1, expected_turns + 1)], 'MCP execution/version receipt missing or duplicated'
            assert len(messages) == expected_turns and all(item['text'] == 'NEEDLE_TARGET_OK' for item in messages), 'Final model did not receive the tool result'
            assert len(calls) == expected_turns * 3, 'Expected search, target call and final response requests per turn'
            assert (code_mode or calls[0]['hasSearch']) and not calls[0]['hasTarget'], 'MCP target schema was not deferred'
            assert code_mode or all(call['hasSearch'] and call['hasTarget'] for call in calls[1:3]), 'Search result schema was not retained'
            assert code_mode or calls[1]['toolsCount'] == calls[0]['toolsCount'] + 1, 'Only the discovered MCP schema should load'
            if code_mode:
                for phase in range(expected_turns):
                    assert calls[phase * 3 + 1]['searchResultNames'] == ['mcp__synthetic__needle_target'], 'Code Mode search did not return the target declaration'
                if history_evolution:
                    assert calls[4]['searchResultSchemaV2'], 'Code Mode replay did not discover the revised schema'
            elif history_evolution:
                assert calls[4]['targetSchemaV2'] and calls[5]['targetSchemaV2'], 'Replay retained stale V1 schema after discovery'
            assert calls[0]['toolsCount'] < 30 and calls[0]['toolsBytes'] < 30000, 'Unrelated MCP schemas were eagerly exposed'
            assert all(call['includeUsage'] for call in calls), 'Bridge did not request streaming usage'
            for index, turn in enumerate(turns, 1):
                # Codex exec reports the saved thread's cumulative usage after resume.
                assert turn['usage']['input_tokens'] == 300 * index and turn['usage']['cached_input_tokens'] == 180 * index, f'Usage input/cache details were lost: {turn["usage"]}'
                assert turn['usage']['reasoning_output_tokens'] == 6 * index, 'Usage reasoning details were lost'
            print(json.dumps({'lite': lite, 'code_mode': code_mode, 'history_evolution': history_evolution,
                              'exit_codes': [result.returncode for result in results], 'synthetic_mcp_tools': 129,
                              'requests': len(calls), 'mcp_calls': len(executed),
                              'initial_tools_count': calls[0]['toolsCount'], 'initial_tools_bytes': calls[0]['toolsBytes'],
                              'discovered_tools_count': calls[1]['toolsCount'], 'discovered_tools_bytes': calls[1]['toolsBytes'],
                              'schema_versions_executed': [item['schema_version'] for item in executed],
                              'usage': turns[-1]['usage'], 'search_result_names': calls[1].get('searchResultNames') if code_mode else None}, ensure_ascii=False))
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
    parser.add_argument('--history-evolution', action='store_true', help='Resume the same saved thread after changing the MCP schema')
    args = parser.parse_args()
    run(lite=args.lite, code_mode=args.code_mode, history_evolution=args.history_evolution)
