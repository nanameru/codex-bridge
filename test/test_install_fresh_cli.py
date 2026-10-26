import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('install_fresh', ROOT / 'scripts/install_fresh_cli.py')
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)

class InstallFreshTests(unittest.TestCase):
    def test_existing_path_and_new_shell_use_fresh_entry_and_survive_update(self):
        with tempfile.TemporaryDirectory(prefix='fresh cli $literal ') as directory:
            home = Path(directory)
            real = home / '.codex/packages/standalone/current/bin/codex'
            real.parent.mkdir(parents=True)
            real.write_text('#!' + sys.executable + '\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n')
            real.chmod(0o700)
            visible = home / '.local/bin/codex'
            visible.parent.mkdir(parents=True)
            visible.symlink_to(real)
            shell = home / '.zshenv'
            original = '# existing settings\nexport KEEP_SETTING=yes\n'
            shell.write_text(original)
            backup = installer.install(home, ROOT / 'scripts/codex_fresh.py')
            self.assertEqual((backup / 'zshenv.before').read_text(), original)
            result = subprocess.check_output([str(visible), 'resume', 'test-id'], text=True)
            self.assertEqual(json.loads(result), ['--no-daemon', 'resume', 'test-id'])
            # Simulate the official updater; the new-shell function remains stable.
            visible.unlink()
            visible.symlink_to(real)
            env = {**os.environ, 'HOME': directory, 'ZDOTDIR': directory, 'PATH': str(visible.parent) + ':' + os.environ['PATH']}
            result = subprocess.check_output(['zsh', '-c', 'codex'], env=env, text=True)
            self.assertEqual(json.loads(result), ['--no-daemon'])
            installer.install(home, ROOT / 'scripts/codex_fresh.py')
            self.assertEqual(shell.read_text().count(installer.START), 1)

    def test_custom_visible_entry_is_preserved(self):
        with tempfile.TemporaryDirectory(prefix='fresh cli $literal ') as directory:
            home = Path(directory)
            real = home / '.codex/packages/standalone/current/bin/codex'
            real.parent.mkdir(parents=True);real.write_text('original');real.chmod(0o700)
            visible = home / '.local/bin/codex';visible.parent.mkdir(parents=True);visible.write_text('custom')
            with self.assertRaises(ValueError):installer.install(home, ROOT / 'scripts/codex_fresh.py')
            self.assertEqual(visible.read_text(), 'custom')
