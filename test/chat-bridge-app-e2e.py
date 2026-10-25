"""Real Codex app-server: completed tools cannot loop indefinitely through router."""
import importlib.util
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from recover_thread import LocalServer
from unified_config import prepare
spec = importlib.util.spec_from_file_location('router_e2e', ROOT / 'test/codex-router-e2e.py')
e2e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e2e)


def turn(server, thread, text):
    result = server.request('turn/start', {'threadId': thread, 'model': 'opencode/glm-5.3-flash',
                                          'input': [{'type': 'text', 'text': text}]})
    identifier = result['turn']['id']
    count = 0
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        try:
            message = server.messages.get(timeout=1)
        except queue.Empty:
            continue
        if message is None:
            raise RuntimeError('app-server exited')
        if message.get('method') == 'item/tool/call':
            assert message['params']['tool'] == 'route_probe'
            count += 1
            server.send({'id': message['id'], 'result': {'success': True,
                         'contentItems': [{'type': 'inputText', 'text': ('{"status":"pending"}' if text == 'POLL_TRIGGER' and count < 8 else '{"status":"done","result":"OK"}')}]}})
            assert count <= 10, 'recovery/polling exceeded bounded test'
        if message.get('method') == 'turn/completed' and message.get('params', {}).get('turn', {}).get('id') == identifier:
            return message['params']['turn'], count
    raise RuntimeError('turn timed out')


def run():
    previous = os.environ.get('CODEX_HOME')
    source = Path(previous or Path.home() / '.codex')
    with tempfile.TemporaryDirectory(prefix='codex-tool-loop-') as directory:
        home = Path(directory)
        for name in ['models_cache.json', 'model-catalog.json']:
            (home / name).write_bytes((source / name).read_bytes())
        # A discovery cache may contain installed third-party namespaces. This
        # fixture needs only the native template; no live routes or user config.
        cache_path = home / 'models_cache.json'
        cache = json.loads(cache_path.read_text())
        cache['models'] = [model for model in cache['models'] if '/' not in model.get('slug', '')]
        cache_path.write_text(json.dumps(cache))
        prepare(home, ROOT)
        (home / 'bridge-local-token').write_text('a' * 64 + '\n')
        (home / 'bridge-local-token').chmod(0o600)
        (home / 'auth.json').write_text(json.dumps(e2e.fake_auth()))
        (home / 'auth.json').chmod(0o600)
        env = {**os.environ, 'CODEX_HOME': directory, 'MOCK_TOOL_ROUNDTRIP': '1', 'MOCK_TOOL_LOOP': '1'}
        upstream = subprocess.Popen(['node', str(ROOT / 'test/mock-chat-bridge.mjs')], env=env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        server = None
        try:
            base = json.loads(upstream.stdout.readline())['url']
            (home / 'config.toml').write_text('model="opencode/glm-5.3-flash"\nmodel_provider="openai"\n'
                 + 'openai_base_url=' + json.dumps(base) + '\nmodel_catalog_json='
                 + json.dumps(str(home / 'unified-model-catalog.json')) + '\n')
            os.environ['CODEX_HOME'] = directory
            server = LocalServer(os.environ.get('CODEX_BIN', 'codex'))
            server.request('initialize', {'clientInfo': {'name': 'chat-bridge-e2e', 'version': '1'},
                                         'capabilities': {'experimentalApi': True}})
            server.send({'method': 'initialized'})
            thread = server.request('thread/start', {'cwd': directory, 'sandbox': 'read-only', 'approvalPolicy': 'never',
                'dynamicTools': [{'type': 'function', 'name': 'route_probe', 'description': 'Return log results',
                                  'inputSchema': {'type': 'object', 'properties': {'iteration': {'type': 'integer'}}}}]})['thread']['id']
            cases = [('NORMAL', 'completed', 1),
                    ('LOOP_TRIGGER', 'completed', 3), ('POLL_TRIGGER', 'completed', 8),
                    ('MIXED_LOOP', 'completed', 10), ('LENGTH_LOOP', 'completed', 3), ('EMPTY_LOOP', 'completed', 3), ('TRUNCATED', 'failed', 0)]
            if os.environ.get('CHAT_PROTOCOL_CASES') == 'truncated':
                cases = [('TRUNCATED', 'failed', 0)]
            if os.environ.get('CHAT_PROTOCOL_CASES') == 'arguments':
                cases = [('ARGS_RETRY', 'completed', 1), ('ARGS_ALWAYS_BAD', 'failed', 0)]
            for label, expected_status, expected_calls in cases:
                outcome, count = turn(server, thread, label)
                assert outcome['status'] == expected_status and count == expected_calls, (label, outcome, count)
            upstream.stdin.write('summary\n')
            upstream.stdin.flush()
            calls = json.loads(upstream.stdout.readline())['metrics']
            if os.environ.get('CHAT_PROTOCOL_CASES') == 'arguments':
                recovered = [call for call in calls if call['label'] == 'ARGS_RETRY']
                failed = [call for call in calls if call['label'] == 'ARGS_ALWAYS_BAD']
                assert len(recovered) == 3, len(recovered)
                assert 2 <= len(failed) <= 10, len(failed)
                assert not any(call['recovery'] for call in calls)
                print('Real Codex: invalid arguments retried, tool executed once; persistent invalid arguments stopped with zero execution; requests=' + str(len(calls)))
                return
            if os.environ.get('CHAT_PROTOCOL_CASES') == 'truncated':
                assert len(calls) == 1
                print('Truncated tool response rejected with no execution.')
                return
            assert len(calls) == 37, len(calls)
            assert sum(call['recovery'] for call in calls) == 6
            empty_calls = [call for call in calls if call['label'] == 'EMPTY_LOOP' and call['recovery']]
            assert [call['max_tokens'] for call in empty_calls] == [8192, 8192]
            assert all(call['tools'] == 0 for call in empty_calls)
            length_calls = [call for call in calls if call['label'] == 'LENGTH_LOOP' and call['recovery']]
            assert [call['max_tokens'] for call in length_calls] == [8192, 16384]
            assert all(call['tools'] == 0 for call in length_calls)
            assert not any(call['recovery'] for call in calls if call['label'] == 'POLL_TRIGGER')
            print('Real app-server + real Chat bridge: normal=1; repeated result=3 then answer; polling=8 without intervention; changed arguments=10 then answer; length recovery=1 without extra tools; empty recovery=1 without extra tools; truncated tools=0; 37 requests.')
        finally:
            if server:
                server.close()
            upstream.stdin.close()
            try:
                upstream.wait(timeout=5)
            except subprocess.TimeoutExpired:
                upstream.terminate()
                upstream.wait(timeout=5)
            if previous is None:
                os.environ.pop('CODEX_HOME', None)
            else:
                os.environ['CODEX_HOME'] = previous


if __name__ == '__main__':
    run()
