#!/usr/bin/env python3
"""Read-only preflight, and an explicitly approved temporary foreground session."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MODEL = re.compile(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,255}\Z')


def os_kind(platform):
    if platform == 'darwin':
        return 'macOS'
    if platform.startswith('linux'):
        return 'Linux'
    if platform == 'win32':
        return 'Windows'
    return 'unsupported'


def install_kind(path):
    if not path:
        return 'missing'
    value = path.replace('\\', '/').lower()
    if '/.codex/packages/standalone/' in value:
        return 'standalone'
    if '/node_modules/' in value or value.endswith(('/codex.cmd', '/codex.ps1')) or '/npm/' in value:
        return 'npm-or-wrapper'
    return 'binary-or-other-wrapper'


def file_state(path, *, directory=False, private=False):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return 'missing'
    except OSError:
        return 'unavailable'
    if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        return 'unsafe-link'
    if directory:
        if not stat.S_ISDIR(info.st_mode):
            return 'unsafe-type'
    elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        return 'unsafe-type'
    if os.name != 'nt':
        if info.st_uid != os.getuid() or info.st_mode & (0o077 if private else 0o022):
            return 'unsafe-permissions'
    return 'present'


def home_states(root):
    root = Path(root).expanduser().absolute()
    for component in (root, *root.parents):
        try:
            info = component.lstat()
        except FileNotFoundError:
            continue
        except OSError:
            return {'home': 'unavailable', 'config': 'unchecked', 'auth': 'unchecked'}
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            return {'home': 'unsafe-link', 'config': 'unchecked', 'auth': 'unchecked'}
        if (os.name != 'nt' and component != root and info.st_mode & 0o022
                and not info.st_mode & stat.S_ISVTX):
            return {'home': 'unsafe-permissions', 'config': 'unchecked', 'auth': 'unchecked'}
    state = file_state(root, directory=True)
    if state != 'present':
        return {'home': state, 'config': 'unchecked', 'auth': 'unchecked'}
    return {'home': state, 'config': file_state(root / 'config.toml'),
            'auth': file_state(root / 'auth.json', private=True)}


def config_summary(root, states):
    if states.get('config') != 'present':
        return {'status': 'absent-or-unchecked'}
    try:
        import tomllib
        path = root / 'config.toml'
        before = path.lstat()
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
        with os.fdopen(fd, 'rb') as stream:
            current = os.fstat(stream.fileno())
            if ((before.st_dev, before.st_ino, before.st_mode, before.st_nlink) !=
                    (current.st_dev, current.st_ino, current.st_mode, current.st_nlink) or current.st_size > 1024 * 1024):
                return {'status': 'unavailable'}
            data = tomllib.load(stream)
        providers = data.get('model_providers', {})
        if not isinstance(providers, dict):
            return {'status': 'invalid'}
        return {'status': 'conflict' if 'bridge-portable' in providers else 'ok',
                'existing_model_selection': 'model' in data or 'model_provider' in data,
                'existing_catalog': 'model_catalog_json' in data}
    except (ImportError, OSError, ValueError, TypeError):
        return {'status': 'unavailable-or-invalid'}


def port_state(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        try:
            return 'occupied' if sock.connect_ex(('127.0.0.1', port)) == 0 else 'no-listener-detected'
        except OSError:
            return 'unknown'


def node_version(node):
    if not node:
        return None
    try:
        result = subprocess.run([node, '--version'], capture_output=True, text=True, timeout=3, check=True)
        match = re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)\s*', result.stdout)
        return tuple(int(n) for n in match.groups()) if match else None
    except (OSError, subprocess.SubprocessError):
        return None


def make_plan(platform, version, python_version, codex, states, port, config_status='ok'):
    """Pure, fixture-testable decision logic. Never contains config or credentials."""
    issues = []
    if platform == 'Windows':
        issues.append('Windows native ACL verification is unavailable; use WSL and run preflight again inside Linux.')
    elif platform not in ('macOS', 'Linux'):
        issues.append('Unsupported OS; do not start the bridge.')
    if not version or tuple(version) < (22, 16, 0):
        issues.append('Install Node.js 22.16 or newer from https://nodejs.org/ and rerun preflight.')
    if tuple(python_version) < (3, 11):
        issues.append('Install Python 3.11 or newer from https://www.python.org/downloads/ and rerun preflight.')
    if codex == 'missing':
        issues.append('Install Codex CLI using https://developers.openai.com/codex/cli/ and rerun preflight.')
    for name, value in states.items():
        if value.startswith('unsafe') or value == 'unavailable':
            issues.append(name + ' is unsafe or unavailable; inspect locally and do not proceed.')
    if states.get('home') == 'missing':
        issues.append('CODEX_HOME is absent; choose a location and sign in using Codex before continuing.')
    if states.get('auth') == 'missing':
        issues.append('auth.json is absent: macOS Keychain may be in use; on Linux file authentication is required.')
    if config_status not in ('ok', 'absent-or-unchecked'):
        issues.append('Existing config is invalid, unavailable or already defines bridge-portable; inspect locally before proceeding.')
    if port != 'no-listener-detected':
        issues.append('Port is occupied or could not be checked; choose another port and inspect the existing service.')
    blocking = any(x for x in issues if not x.startswith('auth.json is absent:'))
    return {'ready_for_approval': not blocking, 'notes': issues}


def preflight(port):
    root = Path(os.environ.get('CODEX_HOME') or (Path.home() / '.codex')).expanduser().absolute()
    node = shutil.which('node')
    codex = shutil.which('codex')
    kind = os_kind(sys.platform)
    states = home_states(root)
    config = config_summary(root, states)
    version = node_version(node)
    port_status = port_state(port)
    report = {'os': kind, 'node_version': '.'.join(map(str, version)) if version else 'missing-or-unknown',
              'python_version': '.'.join(map(str, sys.version_info[:3])), 'codex_install': install_kind(codex),
              'codex_home': str(root), 'codex_home_source': 'CODEX_HOME' if os.environ.get('CODEX_HOME') else 'default',
              'existing': states, 'config_metadata': config, 'port': port, 'port_state': port_status,
              'plan': make_plan(kind, version, sys.version_info[:3], install_kind(codex), states, port_status, config['status'])}
    return report, node, codex, root


def clean_env(root):
    # Never forward arbitrary provider keys, test endpoints, dump or runtime overrides.
    allowed = ('PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL',
               'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR')
    env = {name: os.environ[name] for name in allowed if name in os.environ}
    env.update(CODEX_HOME=str(root), CODEX_BRIDGE_PYTHON=sys.executable,
               DISABLE_DUMP='1', CODEX_BRIDGE_NO_USAGE='1')
    return env


def catalog_info(args):
    if os.name == 'nt':
        raise ValueError('Native Windows catalog verification is unavailable; use WSL.')
    path = Path(args.catalog).expanduser().absolute()
    if file_state(path, private=True) != 'present' or home_states(path.parent)['home'] != 'present':
        raise ValueError('Catalog must be an owned, private regular file in a safe directory.')
    before = path.lstat()
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(fd, 'rb') as stream:
        current = os.fstat(stream.fileno())
        identity = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
                                 info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        if (identity(before) != identity(current) or not stat.S_ISREG(current.st_mode)
                or current.st_nlink != 1 or current.st_uid != os.getuid() or current.st_mode & 0o077
                or current.st_size > 1024 * 1024):
            raise ValueError('Catalog is unsafe or too large.')
        content = stream.read(1024 * 1024 + 1)
        if len(content) > 1024 * 1024 or identity(current) != identity(os.fstat(stream.fileno())):
            raise ValueError('Catalog changed or is too large.')
    data = json.loads(content)
    if not isinstance(data, dict):
        raise ValueError('Invalid catalog.')
    models = data.get('models')
    if not isinstance(models, list) or not models or len(models) > 500 or not all(isinstance(m, dict) for m in models):
        raise ValueError('Invalid catalog.')
    if any(not isinstance(m.get('slug'), str) or not MODEL.fullmatch(m['slug'])
           or not isinstance(m.get('router_provider'), str) for m in models):
        raise ValueError('Invalid catalog model.')
    entries = {m['slug']: m['router_provider'] for m in models}
    if len(entries) != len(models) or args.model not in entries or entries.get(args.summary_model) != 'openai':
        raise ValueError('Select a catalog model and an OpenAI summary model in the catalog.')
    providers = set(entries.values())
    if not providers <= {'openai', 'opencode', 'commandcode', 'ollama', 'whatstoken'}:
        raise ValueError('Catalog contains an unsupported provider.')
    return path, providers


def wait_child(child, port, mode=None):
    for _ in range(50):
        if child.poll() is not None:
            return False
        try:
            with urllib.request.urlopen('http://127.0.0.1:%d/health' % port, timeout=0.2) as response:
                data = json.load(response)
            if (data.get('ok') and data.get('security') == 'local-owner-v1'
                    and data.get('pid') == child.pid and (mode is None or data.get('mode') == mode)
                    and child.poll() is None):
                return True
        except (OSError, ValueError, urllib.error.URLError):
            pass
        time.sleep(0.1)
    return False


def show_plan(args, report):
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.command != 'preflight':
        print('\nPreview: foreground %s at 127.0.0.1:%d; model %s.' % (args.provider, args.port, args.model))
        if args.provider == 'unified':
            path, providers = catalog_info(args)
            print('Recipient catalog: %s; providers: %s' % (path, ', '.join(sorted(providers))))
            print('OpenAI summary model: %s. Summary requests may send conversation content and incur additional charges.' % args.summary_model)
            print('OpenCode Bridge port: %s (used when the catalog contains OpenCode).' % args.bridge_port)
        print('Temporary overrides:')
        print('  model = ' + json.dumps(args.model))
        print('  model_provider = "bridge-portable"')
        print('  model_providers.bridge-portable.name = "Bridge temporary"')
        print('  model_providers.bridge-portable.base_url = "http://127.0.0.1:%d/v1"' % args.port)
        print('  model_providers.bridge-portable.wire_api = "responses"')
        print('  model_providers.bridge-portable.requires_openai_auth = true')
        print('Codex gets temporary CLI overrides; config/auth/service files are not changed by this launcher.')
        print('Codex itself may save its normal history. The Bridge does not save usage or request dumps.')
        print('Provider receives the request and conversation sent by Codex; provider charges may apply.')


def run_session(args, node, codex, root):
    # An explicit fresh approval is required even when preview was run earlier.
    if input('Start this temporary session? Type YES to approve: ').strip() != 'YES':
        print('Cancelled. No process started.')
        return 1
    if not preflight(args.port)[0]['plan']['ready_for_approval']:
        print('Environment changed or is unsafe; rerun preflight.')
        return 1
    unified = args.provider == 'unified'
    try:
        catalog, providers = catalog_info(args) if unified else (None, {'opencode'})
    except (OSError, ValueError, TypeError):
        print('Catalog changed or is unsafe; rerun preview. No process started.')
        return 1
    if unified and ('opencode' in providers and (args.bridge_port == args.port or port_state(args.bridge_port) != 'no-listener-detected')):
        print('Bridge port unavailable; no process started.')
        return 1
    env = clean_env(root)
    doctor = subprocess.run([node, str(ROOT / 'src/auth-doctor.mjs'), '--root', str(root)],
                            env=env, capture_output=True, text=True, timeout=10)
    if doctor.returncode:
        print('Codex authentication unavailable or unsupported. Run node src/auth-doctor.mjs locally for the reason.')
        return 1
    children = []
    # Ephemeral internal router-to-bridge authentication; never written or passed to Codex.
    internal_token = secrets.token_hex(32) if unified and 'opencode' in providers else None
    try:
        if 'opencode' in providers:
            key = getpass.getpass('OpenCode Go API key (hidden; never paste into chat): ')
            if not key or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in key):
                print('Invalid key input; no process started.')
                return 1
            bridge_port = args.bridge_port if unified else args.port
            bridge_env = dict(env, OPENCODE_API_KEY=key, PORT=str(bridge_port), DEFAULT_MODEL=args.model, LOG_LEVEL='info')
            del key
            if internal_token:
                bridge_env['CODEX_BRIDGE_PORTABLE_LOCAL_TOKEN'] = internal_token
            bridge = subprocess.Popen([node, str(ROOT / 'src/codex-bridge.mjs')], env=bridge_env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            del bridge_env
            children.append(bridge)
            if not wait_child(bridge, bridge_port):
                print('Bridge did not become ready on the selected port. No Codex session started.')
                return 1
        if unified:
            router_env = dict(env)
            if internal_token:
                router_env['CODEX_BRIDGE_PORTABLE_LOCAL_TOKEN'] = internal_token
            router = subprocess.Popen([node, str(ROOT / 'scripts/portable_router.mjs'), str(catalog),
                                       args.summary_model, str(args.port), str(args.bridge_port)],
                                      env=router_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            del router_env
            children.append(router)
            if not wait_child(router, args.port, 'unified'):
                print('Router did not become ready on the selected port. No Codex session started.')
                return 1
        settings = ['model_provider="bridge-portable"',
                    'model_providers.bridge-portable.name="Bridge temporary"',
                    'model_providers.bridge-portable.base_url="http://127.0.0.1:%d/v1"' % args.port,
                    'model_providers.bridge-portable.wire_api="responses"',
                    'model_providers.bridge-portable.requires_openai_auth=true']
        if unified:
            settings.append('model_catalog_json=' + json.dumps(str(catalog), ensure_ascii=False))
        command = [codex, '--model', args.model]
        for setting in settings:
            command.extend(['-c', setting])
        return subprocess.call(command, env=env)
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    print('Process did not stop; stop only the process started by this session manually.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for command in ('preflight', 'preview', 'run'):
        child = sub.add_parser(command)
        child.add_argument('--port', type=int, default=8788)
        if command != 'preflight':
            child.add_argument('--provider', choices=['opencode-go', 'unified'], required=True)
            child.add_argument('--model', required=True)
            child.add_argument('--catalog', help='recipient-owned unified catalog (required for unified)')
            child.add_argument('--summary-model', help='recipient-selected OpenAI model in catalog')
            child.add_argument('--bridge-port', type=int, default=8788)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('port must be 1..65535')
    if args.command != 'preflight' and not MODEL.fullmatch(args.model):
        parser.error('model ID must use letters, digits, dot, underscore or hyphen')
    if args.command != 'preflight' and args.provider == 'unified':
        if not args.catalog or not args.summary_model or not MODEL.fullmatch(args.summary_model):
            parser.error('unified requires --catalog and --summary-model')
        if not 1 <= args.bridge_port <= 65535:
            parser.error('bridge port must be 1..65535')
        try:
            catalog_info(args)
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            parser.error(str(exc))
    report, node, codex, root = preflight(args.port)
    try:
        show_plan(args, report)
    except (OSError, ValueError, TypeError):
        parser.error('Catalog changed or is unsafe; rerun preview. No process started.')
    if args.command == 'run':
        if not report['plan']['ready_for_approval']:
            print('Preflight blocked; no process started.')
            return 1
        return run_session(args, node, codex, root)
    return 0 if report['plan']['ready_for_approval'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, EOFError, KeyboardInterrupt, subprocess.SubprocessError):
        sys.exit('Cancelled or unavailable; no secret is displayed.')
