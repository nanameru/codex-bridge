"""実Codex/隔離設定/模擬上流による4社の手動切替。実API要求なし。"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

h = load('handoff', ROOT / 'test/handoff-app-e2e.py')
m = load('manual', ROOT / 'scripts/manual_providers.py')
original = os.environ.get('CODEX_HOME')
source = Path(original or Path.home() / '.codex')
with tempfile.TemporaryDirectory(prefix='manual-providers-e2e-') as directory:
    home = Path(directory)
    for name in ['models_cache.json', 'model-catalog.json']:
        cache = json.loads((source / name).read_text())
        if name == 'models_cache.json':
            cache['models'] = [m for m in cache['models'] if m.get('slug') == 'gpt-6.1-sol']
        (home / name).write_text(json.dumps(cache))
    h.prepare(home, ROOT)
    m.install_models(home)
    (home / 'auth.json').write_text(json.dumps(h.e2e.fake_auth()))
    (home / 'auth.json').chmod(0o600)
    env = {**os.environ, 'CODEX_HOME': directory}
    upstream = subprocess.Popen(['node', str(ROOT / 'test/mock-manual.mjs')], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    server = None
    try:
        base = json.loads(upstream.stdout.readline())['url']
        (home / 'config.toml').write_text('model="gpt-6.1-sol"\nmodel_provider="openai"\nopenai_base_url=' + json.dumps(base)
            + '\nmodel_catalog_json=' + json.dumps(str(home / 'unified-model-catalog.json')) + '\n')
        os.environ['CODEX_HOME'] = directory
        binary = os.environ.get('CODEX_BIN', 'codex')
        server = h.start(binary)
        listed = json.dumps(server.request('model/list', {'includeHidden': False}))
        assert 'commandcode/deepseek-v4.1-flash' in listed
        assert 'ollama/deepseek-v4.1-flash' in listed
        assert 'commandcode/moonshotai/Kimi-K3.1-Pro' in listed
        thread = server.request('thread/start', {'cwd': directory, 'sandbox': 'read-only', 'approvalPolicy': 'never'})['thread']['id']
        for model, provider in [('gpt-6.1-sol', 'openai'), ('opencode/deepseek-v4.1-flash', 'opencode'),
                               ('commandcode/deepseek-v4.1-flash', 'commandcode'), ('commandcode/moonshotai/Kimi-K3.1-Pro', 'commandcode'), ('ollama/deepseek-v4.1-flash', 'ollama')]:
            messages, status = h.turn(server, thread, model)
            assert status == 'completed', status
            assert any(provider + '_OK' in x.get('params', {}).get('delta', '') for x in messages), provider
            if provider in ['commandcode', 'ollama']:
                h.compact(server, thread)
                messages, status = h.turn(server, thread, None)
                assert status == 'completed', status
                assert any(provider + '_OK' in x.get('params', {}).get('delta', '') for x in messages), provider
        server.close()
        server = h.start(binary)
        server.request('thread/resume', {'threadId': thread, 'excludeTurns': True})
        messages, status = h.turn(server, thread, None)
        assert status == 'completed'
        assert any('ollama_OK' in x.get('params', {}).get('delta', '') for x in messages)
        _, status = h.turn(server, thread, 'gpt-6.1-sol')
        assert status == 'completed'
        upstream.stdin.write('summary\n'); upstream.stdin.flush()
        calls = json.loads(upstream.stdout.readline())['calls']
        assert all(c['expectedKey'] and not c['nativeLeak'] for c in calls)
        assert {c['provider'] for c in calls} == {'openai', 'opencode', 'commandcode', 'ollama'}
        print(f'実Codex: 4社のmodel/list・同一会話手動切替・圧縮後の選択保持・保存再開成功。模擬要求{len(calls)}件、認証分離成功、実API0。')
    finally:
        if server:
            server.close()
        upstream.stdin.close()
        try:
            upstream.wait(timeout=5)
        except subprocess.TimeoutExpired:
            upstream.terminate(); upstream.wait(timeout=5)
        if original is None:
            os.environ.pop('CODEX_HOME', None)
        else:
            os.environ['CODEX_HOME'] = original
