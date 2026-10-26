import importlib.util
import json
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
        self.real = self.root / 'real codex'
        self.write_real(23)
        (self.stable / 'codex-real').symlink_to(self.real)

    def write_real(self, status):
        self.real.write_text('#!' + sys.executable + '\nimport json,sys\n'
                             + 'print(json.dumps({"executable":sys.argv[0],"args":sys.argv[1:]}))\n'
                             + f'raise SystemExit({status})\n')
        self.real.chmod(0o700)

    def invoke(self, args, entry=None):
        return subprocess.run([str(entry or self.entry), *args], capture_output=True, text=True, timeout=10)

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


if __name__ == '__main__':
    unittest.main()
