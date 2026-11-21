import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('codex_fresh', ROOT / 'scripts/codex_fresh.py')
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)
SESSION = '01a176c6-9969-7ad3-939f-e75e26bd35e4'
LEGACY_SESSION = '01a1777d-0ab9-7ae0-bd5d-846e836e21e0'
PROVIDER_ARGS = ['-c', 'model_provider="codex-bridge"']


def write_session(home, provider='openai', models=('opencode/deepseek-v4.1-flash',),
                  session_id=LEGACY_SESSION):
    path = home / 'sessions/2026/10/26' / ('rollout-2026-10-26T20-14-05-' + session_id + '.jsonl')
    path.parent.mkdir(parents=True, exist_ok=True)
    records = [{'type': 'session_meta', 'payload': {'id': session_id,
                                                     'model_provider': provider}}]
    records.extend({'type': 'turn_context', 'payload': {'model': model}} for model in models)
    path.write_text(''.join(json.dumps(record) + '\n' for record in records))
    return path


def write_provider_settings(home, base_url='http://127.0.0.1:8791/v1'):
    catalog = home / 'catalog.json'
    catalog.write_text(json.dumps({'models': [
        {'slug': 'opencode/deepseek-v4.1-flash', 'router_provider': 'opencode'},
        {'slug': 'gpt-6.1-sol'},
        {'slug': 'unknown-router-model'},
    ]}))
    (home / 'config.toml').write_text(
        'model="opencode/deepseek-v4.1-flash"\n'
        'model_provider="codex-bridge"\n'
        f'model_catalog_json={json.dumps(str(catalog))}\n'
        '[model_providers.codex-bridge]\n'
        'name="codex bridge"\n'
        'wire_api="responses"\n'
        'requires_openai_auth=true\n'
        f'base_url={json.dumps(base_url)}\n')
    return catalog


class FreshArgumentsTests(unittest.TestCase):
    def test_plain_prompt_resume_and_fork_use_a_fresh_server(self):
        for args in [[], ['a prompt with spaces'], ['resume', SESSION], ['resume', '--last'],
                     ['fork', SESSION], ['fork', '--last', '--all'],
                     ['-m', 'gpt-6.1-sol', 'resume', SESSION],
                     ['--profile', 'work', 'resume', SESSION],
                     ['--enable', 'something', 'fork', SESSION],
                     ['resume', '-c', 'model="example"', SESSION, 'next task']]:
            with self.subTest(args=args):
                self.assertEqual(launcher.rewrite_arguments(args), ['--no-daemon', *args])

    def test_option_values_and_literal_separator_are_not_commands_or_flags(self):
        for args in [['-m', 'agents'], ['--model=exec'], ['-mexec'],
                     ['-c', 'value="--remote"', 'resume', SESSION],
                     ['--config=value="agents"', 'resume', SESSION],

                     ['--add-dir', 'agents', 'a prompt'], ['--cd', 'exec'],
                     ['--', '--remote', 'agents'], ['resume', SESSION, '--', '--no-daemon'],
                     ['--image', 'one.png', 'agents', 'two.png'],
                     ['--image=one.png', 'resume', SESSION], ['-ione.png', 'fork', SESSION]]:
            with self.subTest(args=args):
                self.assertEqual(launcher.rewrite_arguments(args), ['--no-daemon', *args])

    def test_remote_existing_flag_and_non_tui_commands_are_unchanged(self):
        for args in [['--remote', 'unix://'], ['--remote=ws://localhost:1234'],
                     ['resume', SESSION, '--remote', 'unix://'], ['--no-daemon'],
                     ['resume', '--no-daemon', SESSION], ['fork', SESSION, '--no-daemon'],
                     ['agents'], ['agents', '--remote', 'unix://'], ['exec', 'print OK'],
                     ['e', 'prompt'], ['review'], ['app-server', '--stdio'],
                     ['app-server', 'daemon', 'restart'], ['remote-control', 'start'],
                     ['-c', 'model="example"', 'exec', 'prompt'], ['update'], ['features', 'list'],
                     ['login'], ['logout'], ['mcp', 'list'], ['plugin', 'list'], ['completion', 'zsh'],
                     ['doctor'], ['debug', 'models'], ['sandbox', '--help'], ['apply'], ['a'],
                     ['cloud'], ['cloud-tasks'], ['queue', SESSION, 'hello'], ['archive', SESSION],
                     ['delete', SESSION], ['unarchive', SESSION], ['migrate-rollouts'], ['migrate-nfs-db'],
                     ['exec-server'], ['stdio-to-uds'], ['responses-api-proxy'], ['tcp-tunnel'], ['execpolicy'],
                     ['-ione.png', 'agents'], ['--image=one.png', 'agents'],
                     ['--help'], ['--version']]:
            with self.subTest(args=args):
                self.assertEqual(launcher.rewrite_arguments(args), args)

    def test_unknown_or_incomplete_options_are_left_for_codex_to_validate(self):
        for args in [['--future-flag', 'agents'], ['--future=resume'], ['-Z'],
                     ['-c'], ['--model'], ['--image'], ['--model', '--search'],
                     ['--no-daemon=true'], ['--search=true'], ['--config', '--remote=not-an-option']]:
            with self.subTest(args=args):
                self.assertEqual(launcher.rewrite_arguments(args), args)


class ResumeProviderMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        write_provider_settings(self.home)

    def prepare(self, args=None):
        return launcher.prepare_arguments(args or ['resume', LEGACY_SESSION], self.home)

    def assert_unchanged(self, args=None):
        args = args or ['resume', LEGACY_SESSION]
        rewritten, migrated = self.prepare(args)
        self.assertFalse(migrated)
        self.assertEqual(rewritten, launcher.rewrite_arguments(args))

    def test_legacy_openai_provider_is_migrated_without_rewriting_session(self):
        path = write_session(self.home)
        original = path.read_bytes()
        stat = path.stat()
        config = (self.home / 'config.toml').read_bytes()
        catalog = (self.home / 'catalog.json').read_bytes()

        rewritten, migrated = self.prepare()

        self.assertTrue(migrated)
        self.assertEqual(rewritten, ['--no-daemon', 'resume', *PROVIDER_ARGS, LEGACY_SESSION])
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(path.stat().st_mtime_ns, stat.st_mtime_ns)
        self.assertEqual((path.stat().st_uid, path.stat().st_gid), (stat.st_uid, stat.st_gid))
        self.assertEqual((self.home / 'config.toml').read_bytes(), config)
        self.assertEqual((self.home / 'catalog.json').read_bytes(), catalog)

    def test_last_turn_context_controls_the_target_provider(self):
        write_session(self.home, models=('opencode/deepseek-v4.1-flash', 'gpt-6.1-sol'))
        self.assert_unchanged()

        write_session(self.home, models=('gpt-6.1-sol', 'opencode/deepseek-v4.1-flash'))
        rewritten, migrated = self.prepare()
        self.assertTrue(migrated)
        self.assertEqual(rewritten, ['--no-daemon', 'resume', *PROVIDER_ARGS, LEGACY_SESSION])

    def test_valid_openai_and_bridge_sessions_are_unchanged(self):
        cases = [('openai', ('gpt-6.1-sol',)), ('codex-bridge', ('opencode/deepseek-v4.1-flash',)),
                 ('openai', ('unknown-router-model',))]
        for provider, models in cases:
            with self.subTest(provider=provider, models=models):
                for path in (self.home / 'sessions').rglob('*.jsonl'):
                    path.unlink()
                write_session(self.home, provider=provider, models=models)
                self.assert_unchanged()

    def test_explicit_model_provider_profile_remote_and_last_are_preserved(self):
        write_session(self.home)
        cases = [
            ['resume', '-m', 'gpt-6.1-sol', LEGACY_SESSION],
            ['resume', '-c', 'model="gpt-6.1-sol"', LEGACY_SESSION],
            ['resume', '-c', 'model_provider="opencode-go-direct"', LEGACY_SESSION],
            ['--profile', 'work', 'resume', LEGACY_SESSION],
            ['resume', '--remote', 'unix://', LEGACY_SESSION],
            ['resume', '--last'],
            ['fork', LEGACY_SESSION],
        ]
        for args in cases:
            with self.subTest(args=args):
                self.assert_unchanged(args)

    def test_duplicate_and_symlink_sessions_fail_closed(self):
        path = write_session(self.home)
        second = self.home / 'sessions/2026/10/27'
        second.mkdir(parents=True)
        (second / ('rollout-' + LEGACY_SESSION + '.jsonl')).write_bytes(path.read_bytes())
        self.assert_unchanged()

    def test_symlink_session_fails_closed(self):
        path = write_session(self.home)
        link = path.parent / ('rollout-symlink-' + LEGACY_SESSION + '.jsonl')
        link.symlink_to(path)
        self.assert_unchanged()

    def test_unknown_router_and_non_loopback_provider_fail_closed(self):
        write_session(self.home)
        catalog = json.loads((self.home / 'catalog.json').read_text())
        catalog['models'][0]['router_provider'] = 'unknown'
        (self.home / 'catalog.json').write_text(json.dumps(catalog))
        self.assert_unchanged()

        catalog['models'][0]['router_provider'] = 'opencode'
        (self.home / 'catalog.json').write_text(json.dumps(catalog))
        config = (self.home / 'config.toml').read_text()
        (self.home / 'config.toml').write_text(config.replace(
            'http://127.0.0.1:8791/v1', 'https://bridge.example.invalid/v1'))
        self.assert_unchanged()

    def test_invalid_session_and_catalog_fail_closed(self):
        path = write_session(self.home)
        path.write_text('{not json}\n')
        self.assert_unchanged()

        path.unlink()
        write_session(self.home)
        (self.home / 'catalog.json').write_text('{not json}\n')
        self.assert_unchanged()

class FreshExecutableTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.stable = self.root / 'stable'
        self.stable.mkdir()
        self.entry = self.stable / 'codex'
        shutil.copyfile(ROOT / 'scripts/codex_fresh.py', self.entry)
        self.entry.chmod(0o700)
        self.empty_home = self.root / 'empty-codex'
        self.empty_home.mkdir()
        self.real = self.root / 'real codex'
        self.write_real(23)
        (self.stable / 'codex-real').symlink_to(self.real)

    def write_real(self, status):
        self.real.write_text('#!' + sys.executable + '\nimport json,sys\n'
                             + 'print(json.dumps({"executable":sys.argv[0],"args":sys.argv[1:]}))\n'
                             + f'raise SystemExit({status})\n')
        self.real.chmod(0o700)

    def invoke(self, args, entry=None, home=None):
        env = os.environ.copy()
        env['CODEX_HOME'] = str(home or self.empty_home)
        return subprocess.run([str(entry or self.entry), *args], capture_output=True, text=True,
                              timeout=10, env=env)

    def test_actual_exec_preserves_json_arguments_and_exit_status(self):
        unusual = '調査完了\nline two with spaces; $() `literal` "quote" \\slash'
        cases = [([], ['--no-daemon']), ([''], ['--no-daemon', '']),
                 (['resume', SESSION], ['--no-daemon', 'resume', SESSION]),
                 (['fork', '--last'], ['--no-daemon', 'fork', '--last']),
                 ([unusual], ['--no-daemon', unusual]),
                 (['--', '--remote', 'a prompt'], ['--no-daemon', '--', '--remote', 'a prompt']),
                 (['exec', 'unchanged; command'], ['exec', 'unchanged; command']),
                 (['resume', '--remote', 'unix://', SESSION], ['resume', '--remote', 'unix://', SESSION])]
        for args, expected in cases:
            with self.subTest(args=args):
                result = self.invoke(args)
                self.assertEqual(result.returncode, 23, result.stderr)
                self.assertEqual(json.loads(result.stdout), {
                    'executable': str(self.real.resolve()), 'args': expected})

    def test_stable_entry_survives_visible_installer_symlink_replacement(self):
        visible = self.root / 'visible'
        visible.mkdir()
        command = visible / 'codex'
        command.symlink_to(self.entry)
        first = self.invoke(['resume', SESSION], command)
        self.assertEqual(json.loads(first.stdout)['args'], ['--no-daemon', 'resume', SESSION])
        command.unlink()
        command.symlink_to(self.real)  # Simulate the official installer owning only this entry.
        result = self.invoke(['resume', SESSION], self.entry)
        self.assertEqual(result.returncode, 23)
        self.assertEqual(json.loads(result.stdout)['args'], ['--no-daemon', 'resume', SESSION])
        # Official package selection can advance without rewriting the launcher.
        updated = self.root / 'new release'
        updated.write_bytes(self.real.read_bytes())
        updated.chmod(0o700)
        sibling = self.stable / 'codex-real'
        sibling.unlink()
        sibling.symlink_to(updated)
        result = self.invoke(['fork', '--last'])
        self.assertEqual(json.loads(result.stdout)['executable'], str(updated.resolve()))
        self.assertEqual(json.loads(result.stdout)['args'], ['--no-daemon', 'fork', '--last'])

    def test_missing_or_recursive_real_target_fails_without_falling_back_to_path(self):
        sibling = self.stable / 'codex-real'
        sibling.unlink()
        self.assertEqual(self.invoke([]).returncode, 126)
        sibling.symlink_to(self.entry)
        self.assertEqual(self.invoke([]).returncode, 126)

    def test_exec_automatically_migrates_a_known_legacy_resume(self):
        home = self.root / 'codex-home'
        home.mkdir()
        write_provider_settings(home)
        session = write_session(home)
        original = session.read_bytes()

        result = self.invoke(['resume', LEGACY_SESSION], home=home)

        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual(json.loads(result.stdout)['args'], [
            '--no-daemon', 'resume', *PROVIDER_ARGS, LEGACY_SESSION])
        self.assertEqual(session.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
