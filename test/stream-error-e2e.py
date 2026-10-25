"""Verify that the real Codex protocol client receives a safe streaming error.
Uses an isolated CODEX_HOME, a synthetic key, and an in-memory mock upstream.
"""
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


def run(mode):
    with tempfile.TemporaryDirectory(prefix='codex-stream-error-') as directory:
        environment = {**os.environ, 'CODEX_HOME': directory,
                       'STREAM_ERROR_TEST_MODE': mode, 'STREAM_TEST_KEY': 'synthetic-stream-key'}
        driver = subprocess.Popen(['node', str(ROOT / 'test/stream-error-driver.mjs')],
                                  env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  text=True, bufsize=1)
        original_home = os.environ.get('CODEX_HOME')
        original_key = os.environ.get('STREAM_TEST_KEY')
        server = None
        try:
            base = json.loads(driver.stdout.readline())['url']
            Path(directory, 'config.toml').write_text(
                'model="gpt-6.1-sol"\nmodel_provider="stream-mock"\nweb_search="disabled"\n'
                '[model_providers.stream-mock]\nname="isolated stream mock"\nwire_api="responses"\n'
                'requires_openai_auth=false\nenv_key="STREAM_TEST_KEY"\n'
                'request_max_retries=0\nstream_max_retries=0\nbase_url=' + json.dumps(base) + '\n')
            os.environ['CODEX_HOME'] = directory
            os.environ['STREAM_TEST_KEY'] = 'synthetic-stream-key'
            server = LocalServer(os.environ.get('CODEX_BIN', 'codex'))
            server.request('initialize', {'clientInfo': {'name': 'stream-error-e2e', 'version': '1'}})
            server.send({'method': 'initialized'})
            thread = server.request('thread/start', {'cwd': directory, 'sandbox': 'read-only',
                                                    'approvalPolicy': 'never'})['thread']['id']
            turn = server.request('turn/start', {'threadId': thread,
                        'input': [{'type': 'text', 'text': 'Reply OK without using tools.'}]})['turn']['id']
            deadline = time.monotonic() + 20
            while True:
                message = server.messages.get(timeout=max(0.01, deadline-time.monotonic()))
                assert message is not None, 'isolated app-server exited'
                result = message.get('params', {}).get('turn', {})
                if message.get('method') == 'turn/completed' and result.get('id') == turn:
                    assert result['status'] == 'failed', result['status']
                    expected = 'request_timeout' if mode == 'timeout' else 'upstream_stream_error'
                    assert expected in json.dumps(result.get('error')), result.get('error')
                    assert 'PRIVATE_STREAM_PROBE' not in json.dumps(result)
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError('isolated CLI did not finish')
            metric = json.loads(driver.stdout.readline())
            assert metric['outcome'] == ('timeout' if mode == 'timeout' else 'failed'), metric
            assert metric['calls'] == 1, 'unexpected inference retry'
            print(mode + ': real Codex received the reason; one mocked inference, no retry')
        finally:
            if server:
                server.close()
            for key, value in [('CODEX_HOME', original_home), ('STREAM_TEST_KEY', original_key)]:
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
            driver.stdin.close()
            try:
                driver.wait(timeout=5)
            except subprocess.TimeoutExpired:
                driver.terminate()
                driver.wait(timeout=5)
            driver.stdout.close()


if __name__ == '__main__':
    run('reset')
    run('timeout')
