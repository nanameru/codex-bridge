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
                path = home / 'Library/LaunchAgents/com.kimurataiyou.codex-model-router.plist'
                if existing:
                    path.parent.mkdir(parents=True)
                    path.write_bytes(plistlib.dumps({
                        'Label': 'com.kimurataiyou.codex-model-router',
                        'EnvironmentVariables': {'CODEX_HOME': str(root), 'KEEP': 'old-setting',
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


class RouterInputServiceTests(unittest.TestCase):
    LIMITS = ('ROUTER_MAX_FORWARDED_BYTES', 'ROUTER_MAX_REQUEST_BYTES')

    def test_input_environment_defaults_override_preserve_and_validate(self):
        forward, receive = self.LIMITS
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(install_router_service.router_input_environment({'KEEP': 'old'}), {'KEEP': 'old'})
            previous = {forward: '100', receive: '200', 'KEEP': 'old'}
            self.assertEqual(install_router_service.router_input_environment(previous), previous)
            with mock.patch.dict(os.environ, {forward: '150'}):
                self.assertEqual(install_router_service.router_input_environment(previous),
                                 {forward: '150', receive: '200', 'KEEP': 'old'})
                self.assertEqual(previous[forward], '100')
            with mock.patch.dict(os.environ, {forward: '1', receive: str(512 * 1024 * 1024)}):
                result = install_router_service.router_input_environment(previous)
                self.assertEqual((result[forward], result[receive]), ('1', str(512 * 1024 * 1024)))
            for name in self.LIMITS:
                for invalid in ('', '0', '-1', '+1', '1.0', '1e3', ' 1', '1 ', '1\n', '１', 'NaN', 'Infinity', '0x10', str(512 * 1024 * 1024 + 1)):
                    with self.subTest(name=name, invalid=invalid), mock.patch.dict(os.environ, {name: invalid}):
                        with self.assertRaises(ValueError):
                            install_router_service.router_input_environment({})
                with self.subTest(name=name, invalid='non-string previous'):
                    with self.assertRaises(ValueError):
                        install_router_service.router_input_environment({name: 12})
            with mock.patch.dict(os.environ, {forward: '201', receive: '200'}):
                with self.assertRaises(ValueError):
                    install_router_service.router_input_environment(previous)

    def test_installer_generated_environment_and_failures_precede_side_effects(self):
        forward, receive = self.LIMITS
        scenarios = [
            ('fresh', {}, {forward: '101', receive: '202'}, None),
            ('preserved', {forward: '100', receive: '200'}, {}, None),
            ('overridden', {forward: '100', receive: '200'}, {forward: '150'}, None),
            ('bad-input', {forward: '100', receive: '200'}, {forward: '201'}, 'input'),
            ('bad-python', {}, {}, 'python'),
        ]
        for label, old_limits, overrides, failure in scenarios:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                home = Path(directory).resolve()
                root = home / 'codex'
                root.mkdir(mode=0o700)
                (root / 'unified-model-catalog.json').write_text('{"models":[]}')
                path = home / 'Library/LaunchAgents/com.kimurataiyou.codex-model-router.plist'
                previous_bytes = None
                if label in ('preserved', 'overridden', 'bad-input'):
                    path.parent.mkdir(parents=True)
                    previous_bytes = plistlib.dumps({'Label': 'com.kimurataiyou.codex-model-router',
                        'EnvironmentVariables': {'CODEX_HOME': str(root), 'KEEP': 'old', **old_limits}})
                    path.write_bytes(previous_bytes)

                def run(command, **kwargs):
                    if command[0] == os.path.abspath(sys.executable):
                        if failure == 'python':
                            raise subprocess.CalledProcessError(1, command)  # Missing tomllib or incompatible version.
                        return subprocess.CompletedProcess(command, 0)
                    return subprocess.CompletedProcess(command, 1 if command[0] == 'launchctl' else 0)

                env = {'CODEX_HOME': str(root), **overrides}
                with mock.patch.dict(os.environ, env, clear=True), \
                        mock.patch.object(sys, 'argv', ['install_router_service.py', '--update-if-idle']), \
                        mock.patch.object(sys, 'platform', 'darwin'), \
                        mock.patch.object(Path, 'home', return_value=home), \
                        mock.patch.object(install_router_service.shutil, 'which', return_value='/node/bin/node'), \
                        mock.patch.object(subprocess, 'run', side_effect=run) as subprocess_run, \
                        mock.patch.object(install_router_service, 'wait_for_idle'), \
                        mock.patch.object(install_router_service, 'replace_registration') as replace, \
                        mock.patch.object(install_router_service, 'ensure_bridge_key', wraps=install_router_service.ensure_bridge_key) as ensure:
                    if failure:
                        with self.assertRaises(ValueError):
                            install_router_service.install()
                        ensure.assert_not_called()
                        replace.assert_not_called()
                        self.assertFalse((root / 'router-runtime').exists())
                        self.assertFalse((root / 'log').exists())
                        self.assertFalse((root / 'bridge-local-token').exists())
                        self.assertEqual(path.read_bytes() if path.exists() else None, previous_bytes)
                        self.assertFalse(any(call.args[0][0] == 'launchctl' for call in subprocess_run.call_args_list))
                    else:
                        install_router_service.install()
                        generated = replace.call_args.args[1]['EnvironmentVariables']
                        self.assertEqual(generated.get(forward), overrides.get(forward, old_limits.get(forward)))
                        self.assertEqual(generated.get(receive), overrides.get(receive, old_limits.get(receive)))
                        if previous_bytes:
                            self.assertEqual(generated['KEEP'], 'old')
                        self.assertEqual(generated['CODEX_BRIDGE_PYTHON'], os.path.abspath(sys.executable))


if __name__ == '__main__':
    unittest.main()
