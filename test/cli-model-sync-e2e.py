"""実CLIと共有サーバー/合成認証/模擬上流で選択モデル表示と復帰を検証する。"""
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
with tempfile.TemporaryDirectory(prefix='provider-fallback-e2e-') as directory:
    home = Path(directory)
    for name in ['models_cache.json', 'model-catalog.json']:
        cache = json.loads((source / name).read_text())
        if name == 'models_cache.json':
            cache['models'] = [m for m in cache['models'] if m.get('slug') == 'gpt-6.1-sol']
        (home / name).write_text(json.dumps(cache))
    h.prepare(home, ROOT)
    m.install_models(home, os.environ.get("CODEX_TEST_WHATSTOKEN") == "1")
    if os.environ.get('CODEX_TEST_STALE_CATALOG') == '1':
        catalog = home / 'unified-model-catalog.json'
        (home / 'staged-model-catalog.json').write_bytes(catalog.read_bytes())
        data = json.loads(catalog.read_text())
        data['models'] = [m for m in data['models'] if not m['slug'].startswith('auto-')]
        catalog.write_text(json.dumps(data))
    (home / 'auth.json').write_text(json.dumps({'auth_mode':'apikey','OPENAI_API_KEY':'sk-test-only-do-not-use'}))
    (home / 'auth.json').chmod(0o600)
    env = {**os.environ, 'CODEX_HOME': directory, 'CODEX_TEST_FALLBACK': '1'}
    env['CODEX_TEST_CLI_SYNC'] = '1'
    subprocess.run(['node', str(ROOT / 'test/cli-model-sync-driver.mjs')], env=env, check=True)
