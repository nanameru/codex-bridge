"""Regress launchd's system Python mismatch without touching real services."""
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import install_router_service
from local_security import service_environment


class ServicePythonTests(unittest.TestCase):
    def test_installer_registers_only_the_canonical_8791_service(self):
        self.assertEqual(install_router_service.ROUTER_PORT, 8791)
        self.assertEqual(install_router_service.ROUTER_SERVICES, {
            'com.kimurataiyou.codex-model-router-8791': 8791,
        })

    def test_pins_verified_interpreter_and_preserves_existing_service_settings(self):
        previous = {'PATH': '/custom/bin:/usr/bin:/bin', 'KEEP': 'unchanged',
                    'CODEX_BRIDGE_PYTHON': '/old/python'}
        environment = service_environment(previous, node='/node/bin/node')
        self.assertEqual(previous['CODEX_BRIDGE_PYTHON'], '/old/python')
        self.assertEqual(environment['KEEP'], 'unchanged')
        self.assertEqual(environment['CODEX_BRIDGE_PYTHON'], os.path.abspath(sys.executable))
        self.assertEqual(environment['PATH'].split(':')[0], str(Path(sys.executable).parent))
        self.assertIn('/custom/bin', environment['PATH'].split(':'))
        # The generated environment works even without a login shell's variables.
        subprocess.run([environment['CODEX_BRIDGE_PYTHON'], '-I', '-c', 'import tomllib'],
                       env=environment, check=True, timeout=5)

    def test_missing_or_incompatible_python_fails_before_service_update(self):
        with tempfile.TemporaryDirectory() as directory:
            bad = Path(directory) / 'python3'
            bad.write_text('#!/bin/sh\nexit 91\n')
            bad.chmod(0o700)
            for executable in (str(bad), str(bad) + '-missing'):
                with self.subTest(executable=executable), self.assertRaisesRegex(ValueError, 'Python 3.11'):
                    service_environment(python=executable)

    def test_generated_plist_pins_python_on_first_install_and_update(self):
        real_run = subprocess.run
        for existing in (False, True):
            with self.subTest(existing=existing), tempfile.TemporaryDirectory() as directory:
                home = Path(directory).resolve()
                root = home / 'codex'
                root.mkdir(mode=0o700)
                (root / 'unified-model-catalog.json').write_text('{"models":[]}')
                path = home / 'Library/LaunchAgents/com.kimurataiyou.codex-model-router-8791.plist'
                if existing:
                    path.parent.mkdir(parents=True)
                    path.write_bytes(plistlib.dumps({
                        'Label': 'com.kimurataiyou.codex-model-router-8791',
                        'EnvironmentVariables': {'CODEX_HOME': str(root), 'KEEP': 'old-setting',
                                                 'ROUTER_PORT': '8791',
                                                 'PATH': '/custom/bin:/usr/bin:/bin'},
                    }))

                def run(command, **kwargs):
                    if command[0] == os.path.abspath(sys.executable):
                        return real_run(command, **kwargs)
                    return subprocess.CompletedProcess(command, 1 if command[0] == 'launchctl' else 0)

                with mock.patch.dict(os.environ, {'CODEX_HOME': str(root)}), \
                        mock.patch.object(sys, 'argv', ['install_router_service.py', '--update-if-idle']), \
                        mock.patch.object(sys, 'platform', 'darwin'), \
                        mock.patch.object(Path, 'home', return_value=home), \
                        mock.patch.object(install_router_service.shutil, 'which', return_value='/node/bin/node'), \
                        mock.patch.object(subprocess, 'run', side_effect=run), \
                        mock.patch.object(install_router_service, 'wait_for_idle'), \
                        mock.patch.object(install_router_service, 'replace_registration') as replace:
                    install_router_service.install()
                environment = replace.call_args.args[1]['EnvironmentVariables']
                self.assertEqual(environment['CODEX_BRIDGE_PYTHON'], os.path.abspath(sys.executable))
                self.assertEqual(environment['ROUTER_PORT'], '8791')
                self.assertIn('/node/bin', environment['PATH'].split(':'))
                if existing:
                    self.assertEqual(environment['KEEP'], 'old-setting')
                    self.assertIn('/custom/bin', environment['PATH'].split(':'))

    def test_known_service_selects_its_port_log_and_idle_target(self):
        real_run = subprocess.run
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            root = home / 'codex'
            root.mkdir(mode=0o700)
            (root / 'unified-model-catalog.json').write_text('{"models":[]}')
            label = 'com.kimurataiyou.codex-model-router-8791'
            path = home / f'Library/LaunchAgents/{label}.plist'
            path.parent.mkdir(parents=True)
            path.write_bytes(plistlib.dumps({
                'Label': label,
                'EnvironmentVariables': {'CODEX_HOME': str(root), 'ROUTER_PORT': '8791',
                                         'KEEP': 'existing'},
            }))

            def run(command, **kwargs):
                if command[0] == os.path.abspath(sys.executable):
                    return real_run(command, **kwargs)
                return subprocess.CompletedProcess(command, 1 if command[0] == 'launchctl' else 0)

            with mock.patch.dict(os.environ, {'CODEX_HOME': str(root)}), \
                    mock.patch.object(sys, 'argv', ['install_router_service.py', '--update-if-idle',
                                                    '--service', label]), \
                    mock.patch.object(sys, 'platform', 'darwin'), \
                    mock.patch.object(Path, 'home', return_value=home), \
                    mock.patch.object(install_router_service.shutil, 'which', return_value='/node/bin/node'), \
                    mock.patch.object(subprocess, 'run', side_effect=run), \
                    mock.patch.object(install_router_service, 'wait_for_idle') as wait_for_idle, \
                    mock.patch.object(install_router_service, 'replace_registration') as replace:
                install_router_service.install()
            payload = replace.call_args.args[1]
            self.assertEqual(payload['Label'], label)
            self.assertEqual(payload['EnvironmentVariables']['ROUTER_PORT'], '8791')
            self.assertEqual(payload['EnvironmentVariables']['KEEP'], 'existing')
            self.assertTrue(payload['StandardOutPath'].endswith('model-router-8791.log'))
            self.assertTrue(payload['StandardErrorPath'].endswith('model-router-8791.stderr.log'))
            wait_for_idle.assert_called_once_with(0, ports=(8791,))
            self.assertEqual(replace.call_args.args[2], f'gui/{os.getuid()}/{label}')

    def test_service_port_mismatch_fails_before_update(self):
        real_run = subprocess.run
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            root = home / 'codex'
            root.mkdir(mode=0o700)
            (root / 'unified-model-catalog.json').write_text('{"models":[]}')
            label = 'com.kimurataiyou.codex-model-router-8791'
            path = home / f'Library/LaunchAgents/{label}.plist'
            path.parent.mkdir(parents=True)
            path.write_bytes(plistlib.dumps({
                'Label': label,
                'EnvironmentVariables': {'CODEX_HOME': str(root), 'ROUTER_PORT': '8790'},
            }))

            def run(command, **kwargs):
                if command[0] == os.path.abspath(sys.executable):
                    return real_run(command, **kwargs)
                return subprocess.CompletedProcess(command, 1 if command[0] == 'launchctl' else 0)

            with mock.patch.dict(os.environ, {'CODEX_HOME': str(root)}), \
                    mock.patch.object(sys, 'argv', ['install_router_service.py', '--update-if-idle',
                                                    '--service', label]), \
                    mock.patch.object(sys, 'platform', 'darwin'), \
                    mock.patch.object(Path, 'home', return_value=home), \
                    mock.patch.object(install_router_service.shutil, 'which', return_value='/node/bin/node'), \
                    mock.patch.object(subprocess, 'run', side_effect=run), \
                    mock.patch.object(install_router_service, 'replace_registration') as replace, \
                    self.assertRaisesRegex(SystemExit, 'ROUTER_PORT'):
                install_router_service.install()
            replace.assert_not_called()


if __name__ == '__main__':
    unittest.main()
