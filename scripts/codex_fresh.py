#!/usr/bin/env python3
"""Launch the sibling codex-real and repair known resume provider mismatches."""
import json
import os
from pathlib import Path
import re
import sys
import tomllib
from urllib.parse import urlsplit


# Codex 0.164.0: tui/src/cli.rs, utils/cli/src/shared_options.rs and
# cli/src/main.rs. Unknown options are passed through, never guessed.
VALUE_OPTIONS = {
    '-c', '--config', '--enable', '--disable', '-m', '--model',
    '--local-provider', '-p', '--profile', '-s', '--sandbox',
    '-C', '--cd', '--add-dir', '-a', '--ask-for-approval',
}
SHORT_VALUE_OPTIONS = {'c', 'm', 'p', 's', 'C', 'a', 'i'}
FLAGS = {
    '--strict-config', '--oss', '--approve-for-me', '--not-so-yolo',
    '--dangerously-bypass-approvals-and-sandbox', '--yolo',
    '--dangerously-bypass-hook-trust', '--worktree', '--search', '--no-alt-screen',
}
SESSION_FLAGS = {'--last', '--all', '--include-non-interactive'}
NON_TUI_COMMANDS = {
    'agents', 'tcp-tunnel', 'exec', 'e', 'review', 'login', 'logout', 'mcp',
    'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update',
    'doctor', 'sandbox', 'debug', 'execpolicy', 'apply', 'a', 'queue', 'archive',
    'delete', 'migrate-rollouts', 'migrate-nfs-db', 'unarchive', 'cloud',
    'cloud-tasks', 'responses-api-proxy', 'stdio-to-uds', 'exec-server',
    'features', 'help',
}
ROUTER_PROVIDERS = frozenset({'openai', 'opencode', 'commandcode', 'ollama', 'whatstoken'})
UUID = re.compile(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z')
MAX_CONFIG_BYTES = 4 * 1024 * 1024
MAX_CATALOG_BYTES = 16 * 1024 * 1024
MAX_META_LINE_BYTES = 1024 * 1024
MAX_SESSION_TAIL_BYTES = 16 * 1024 * 1024


def rewrite_arguments(arguments):
    original = list(arguments)
    command = None
    index = 0
    while index < len(original):
        argument = original[index]
        if argument == '--':
            break  # All remaining values are literal, including flag-like prompts.
        if argument in {'--no-daemon', '-h', '--help', '-V', '--version'}:
            return original
        option, separator, value = argument.partition('=')
        if option in {'--remote', '--remote-auth-token-env'}:
            return original
        if argument in FLAGS or (argument in SESSION_FLAGS and command in {'resume', 'fork'}):
            index += 1
            continue
        if option in VALUE_OPTIONS:
            if separator:
                if not value:
                    return original
                index += 1
                continue
            if index + 1 >= len(original) or (original[index + 1].startswith('-') and original[index + 1] != '-'):
                return original
            index += 2
            continue
        # Attached short values (-mMODEL, -cKEY=VALUE) consume that token only.
        if argument.startswith('-') and not argument.startswith('--') and len(argument) > 2 and argument[1] in SHORT_VALUE_OPTIONS:
            index += 1
            continue
        if option == '--image' or argument == '-i':
            if separator:
                if not value:
                    return original
                index += 1
                continue
            # --image FILE... greedily consumes non-options. Codex does not
            # interpret an image value named "agents" or "resume" as a command.
            start = index + 1
            index = start
            while index < len(original) and (not original[index].startswith('-') or original[index] == '-'):
                index += 1
            if index == start:
                return original
            continue
        if argument.startswith('-') and argument != '-':
            return original  # Future/invalid option: let the real CLI validate it.
        if command is None:
            if argument in NON_TUI_COMMANDS:
                return original
            command = argument if argument in {'resume', 'fork'} else 'prompt'
        index += 1
    return ['--no-daemon', *original]


def _config_keys(value):
    """Return top-level keys from a Codex -c/--config override."""
    try:
        parsed = tomllib.loads(value)
    except (tomllib.TOMLDecodeError, TypeError):
        return None
    return frozenset(parsed) if isinstance(parsed, dict) else None


def _resume_session_id(arguments):
    """Extract one explicit UUID only from an unambiguous resume invocation."""
    command = None
    session_id = None
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument == '--':
            break
        option, separator, value = argument.partition('=')
        if option in {'--remote', '--remote-auth-token-env', '--profile', '-p', '--model', '-m'}:
            return None
        if argument in {'--last', '--all', '--include-non-interactive'}:
            return None
        if argument in FLAGS:
            index += 1
            continue
        if option in VALUE_OPTIONS:
            option_value = value if separator else (arguments[index + 1]
                                                    if index + 1 < len(arguments) else None)
            if option_value is None:
                return None
            if option in {'-c', '--config'}:
                keys = _config_keys(option_value)
                if keys is None or keys & {'model', 'model_provider'}:
                    return None
            index += 1 if separator else 2
            continue
        if argument.startswith('-') and not argument.startswith('--') and len(argument) > 2:
            short = argument[:2]
            if short in {'-m', '-p'}:
                return None
            if short == '-c':
                keys = _config_keys(argument[2:])
                if keys is None or keys & {'model', 'model_provider'}:
                    return None
            elif short not in {'-s', '-C', '-a'}:
                return None
            index += 1
            continue
        if argument.startswith('-') and argument != '-':
            return None
        if command is None:
            if argument != 'resume':
                return None
            command = argument
        elif session_id is None:
            if not UUID.fullmatch(argument):
                return None
            session_id = argument
        index += 1
    return session_id if command == 'resume' else None


def _regular_file(path, limit):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise ValueError('expected a bounded regular file')


def _bridge_is_local(config):
    if config.get('model_provider') != 'codex-bridge':
        return False
    providers = config.get('model_providers')
    if not isinstance(providers, dict) or not isinstance(providers.get('codex-bridge'), dict):
        return False
    bridge = providers['codex-bridge']
    if bridge.get('requires_openai_auth') is not True or bridge.get('wire_api') != 'responses':
        return False
    try:
        parsed = urlsplit(bridge.get('base_url'))
        return (parsed.scheme == 'http' and parsed.hostname == '127.0.0.1'
                and parsed.port == 8791 and parsed.path == '/v1'
                and not parsed.username and not parsed.password
                and not parsed.query and not parsed.fragment)
    except (TypeError, ValueError):
        return False


def _read_catalog(path, home):
    if not path.is_absolute():
        raise ValueError('catalog path is not absolute')
    _regular_file(path, MAX_CATALOG_BYTES)
    if not path.resolve(strict=True).is_relative_to(home.resolve(strict=True)):
        raise ValueError('catalog is outside CODEX_HOME')
    catalog = json.loads(path.read_text(encoding='utf-8'))
    models = catalog.get('models') if isinstance(catalog, dict) else None
    if not isinstance(models, list) or not models or len(models) > 1000:
        raise ValueError('invalid model catalog')
    return models


def _find_session(home, session_id):
    sessions = home / 'sessions'
    if sessions.is_symlink() or not sessions.is_dir():
        raise ValueError('invalid sessions directory')
    candidates = []
    for root, _directories, files in os.walk(sessions, followlinks=False):
        for name in files:
            if name.endswith(session_id + '.jsonl'):
                candidates.append(Path(root) / name)
    if len(candidates) != 1:
        raise ValueError('session must resolve exactly once')
    path = candidates[0]
    if path.is_symlink() or not path.is_file():
        raise ValueError('session must be a regular file')
    resolved_home = home.resolve(strict=True)
    if not path.resolve(strict=True).is_relative_to(resolved_home):
        raise ValueError('session is outside CODEX_HOME')
    return path


def _read_session_identity(path, session_id):
    with path.open('rb') as stream:
        first_line = stream.readline(MAX_META_LINE_BYTES + 1)
    if len(first_line) > MAX_META_LINE_BYTES or not first_line:
        raise ValueError('invalid session metadata')
    meta = json.loads(first_line.decode('utf-8'))
    payload = meta.get('payload') if isinstance(meta, dict) else None
    if (meta.get('type') != 'session_meta' or not isinstance(payload, dict)
            or payload.get('id') != session_id):
        raise ValueError('unexpected session metadata')
    return payload.get('model_provider')


def _read_last_turn_model(path):
    with path.open('rb') as stream:
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        start = max(0, size - MAX_SESSION_TAIL_BYTES)
        stream.seek(start)
        tail = stream.read()
    lines = tail.splitlines()
    if start and lines:
        lines = lines[1:]  # The first line may be partial.
    for line in reversed(lines):
        if b'turn_context' not in line:
            continue
        record = json.loads(line.decode('utf-8'))
        if isinstance(record, dict) and record.get('type') == 'turn_context':
            payload = record.get('payload')
            model = payload.get('model') if isinstance(payload, dict) else None
            return model if isinstance(model, str) else None
    return None


def _needs_bridge_migration(home, session_id):
    home = Path(home).expanduser()
    if not home.is_dir():
        return False
    config_path = home / 'config.toml'
    _regular_file(config_path, MAX_CONFIG_BYTES)
    config = tomllib.loads(config_path.read_text(encoding='utf-8'))
    if not _bridge_is_local(config):
        return False

    catalog_path = config.get('model_catalog_json')
    if not isinstance(catalog_path, str):
        return False
    models = _read_catalog(Path(catalog_path), home)
    session = _find_session(home, session_id)
    if _read_session_identity(session, session_id) != 'openai':
        return False
    model = _read_last_turn_model(session)
    matches = [entry for entry in models if isinstance(entry, dict) and entry.get('slug') == model]
    if model is None or len(matches) != 1:
        return False
    router_provider = matches[0].get('router_provider')
    return router_provider in ROUTER_PROVIDERS and router_provider != 'openai'


def prepare_arguments(arguments, home):
    """Add a session-only provider override for a known legacy mismatch."""
    rewritten = rewrite_arguments(arguments)
    if rewritten == list(arguments):
        return rewritten, False
    session_id = _resume_session_id(rewritten[1:])
    if session_id is None:
        return rewritten, False
    try:
        if not _needs_bridge_migration(home, session_id):
            return rewritten, False
    except (OSError, UnicodeError, ValueError, TypeError):
        return rewritten, False
    resume_index = rewritten.index('resume')
    rewritten[resume_index + 1:resume_index + 1] = ['-c', 'model_provider="codex-bridge"']
    return rewritten, True


def main():
    try:
        launcher = Path(__file__).resolve(strict=True)
        real = launcher.with_name('codex-real').resolve(strict=True)
        if not real.is_file() or real == launcher or not os.access(real, os.X_OK):
            raise ValueError('invalid codex-real')
        home = Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')).expanduser()
        arguments, _migrated = prepare_arguments(sys.argv[1:], home)
        os.execv(str(real), [str(real), *arguments])
    except (OSError, RuntimeError, ValueError):
        print('codex-fresh: sibling codex-real is missing or not executable', file=sys.stderr)
        return 126


if __name__ == '__main__':
    raise SystemExit(main())
