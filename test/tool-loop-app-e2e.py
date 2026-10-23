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
                         'contentItems': [{'type': 'inputText', 'text': f'LOG_RESULT_{count}'}]}})
            assert count <= 6, 'loop guard failed to stop before seventh execution'
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
        prepare(home, ROOT)
        (home / 'auth.json').write_text(json.dumps(e2e.fake_auth()))
        (home / 'auth.json').chmod(0o600)
        env = {**os.environ, 'CODEX_HOME': directory, 'MOCK_TOOL_ROUNDTRIP': '1', 'MOCK_TOOL_LOOP': '1'}
        upstream = subprocess.Popen(['node', str(ROOT / 'test/mock-unified.mjs')], env=env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        server = None
        try:
            base = json.loads(upstream.stdout.readline())['url']
            (home / 'config.toml').write_text('model="opencode/glm-5.3-flash"\nmodel_provider="openai"\n'
                 + 'openai_base_url=' + json.dumps(base) + '\nmodel_catalog_json='
                 + json.dumps(str(home / 'unified-model-catalog.json')) + '\n')
            os.environ['CODEX_HOME'] = directory
            server = LocalServer(os.environ.get('CODEX_BIN', 'codex'))
            server.request('initialize', {'clientInfo': {'name': 'tool-loop-e2e', 'version': '1'},
                                         'capabilities': {'experimentalApi': True}})
            server.send({'method': 'initialized'})
            thread = server.request('thread/start', {'cwd': directory, 'sandbox': 'read-only', 'approvalPolicy': 'never',
                'dynamicTools': [{'type': 'function', 'name': 'route_probe', 'description': 'Return log results',
                                  'inputSchema': {'type': 'object', 'properties': {}}}]})['thread']['id']
            normal, count = turn(server, thread, 'Check once then answer')
            assert normal['status'] == 'completed' and count == 1, (normal, count)
            stopped, count = turn(server, thread, 'LOOP_TRIGGER')
            assert stopped['status'] == 'failed' and count == 6, (stopped, count)
            assert '同じツール実行が同一ターンで6回' in stopped['error']['message'], stopped
            recovered, count = turn(server, thread, 'Check once then answer using existing results')
            assert recovered['status'] == 'completed' and count == 1, (recovered, count)
            upstream.stdin.write('summary\n')
            upstream.stdin.flush()
            calls = json.loads(upstream.stdout.readline())['calls']
            assert len(calls) == 10, 'unexpected retries: ' + str(len(calls))
            print('Real app-server: normal tool result -> answer; loop stopped after 6 calls without retries; new user recovers same thread; 10 upstream requests.')
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
