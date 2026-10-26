import hashlib
from pathlib import Path
import plistlib
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import install_chat_protocol_service as installer
from patch_chat_protocol import HELPERS, MANIFEST


class ChatProtocolServiceTests(unittest.TestCase):
    def test_revision_covers_every_dependency_in_fixed_order(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'bridge.mjs'
            paths = [target, *(target.with_name(name) for name in HELPERS), target.with_name('local-security.mjs')]
            for path in paths:
                path.write_text(path.name)
            expected = hashlib.sha256(b''.join(path.name.encode() + b'\0' + path.read_bytes() + b'\0' for path in paths)).hexdigest()
            self.assertEqual(installer.deployment_revision(target), expected)
            for path in paths:
                before = path.read_bytes()
                path.write_bytes(before + b' changed')
                self.assertNotEqual(installer.deployment_revision(target), expected)
                path.write_bytes(before)

    def test_failed_registration_restores_every_helper_and_manifest(self):
        self._rollback_case(existing=True, registration=True)
        self._rollback_case(existing=False, registration=True)

    def test_partial_apply_failure_rolls_back_without_restarting_service(self):
        self._rollback_case(existing=True, registration=False)

    def _rollback_case(self, existing, registration):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            target = home / 'bridge.mjs'
            target.write_text('original source')
            security = home / 'local-security.mjs'
            security.write_text('security stays')
            paths = [*(home / name for name in HELPERS), home / MANIFEST]
            saved = {}
            if existing:
                for path in paths:
                    path.write_text('old ' + path.name)
                    path.chmod(0o640)
                    saved[path] = path.read_bytes()
            label = 'com.kimurataiyou.codex-bridge'
            plist = home / 'Library' / 'LaunchAgents' / (label + '.plist')
            plist.parent.mkdir(parents=True)
            before = plistlib.dumps({'Label': label, 'ProgramArguments': ['node', str(target)]})
            plist.write_bytes(before)

            def fake_apply(_target):
                target.write_text('changed source')
                for path in paths:
                    path.write_text('new ' + path.name)
                if not registration:
                    raise ValueError('apply failed')

            with mock.patch.object(installer.sys, 'platform', 'darwin'), \
                    mock.patch.object(installer.Path, 'home', return_value=home), \
                    mock.patch.object(installer, 'apply', side_effect=fake_apply), \
                    mock.patch.object(installer, 'wait_for_idle') as idle, \
                    mock.patch.object(installer, 'replace_registration', side_effect=ValueError('registration failed')) as replace, \
                    mock.patch.object(installer.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run:
                with self.assertRaisesRegex(ValueError, 'failed'):
                    installer.install(target)
                idle.assert_called_once_with(0, ports=(8788,))
                self.assertEqual(replace.call_count, int(registration))
                self.assertEqual(run.call_count, 1 + int(registration))
            self.assertEqual(target.read_text(), 'original source')
            self.assertEqual(security.read_text(), 'security stays')
            self.assertEqual(plist.read_bytes(), before)
            for path in paths:
                if existing:
                    self.assertEqual(path.read_bytes(), saved[path])
                    self.assertEqual(path.stat().st_mode & 0o777, 0o640)
                else:
                    self.assertFalse(path.exists())


if __name__ == '__main__':
    unittest.main()
