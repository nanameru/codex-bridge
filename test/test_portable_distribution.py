import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile


REPO = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, REPO / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build = load('build_distribution', 'scripts/build_distribution.py')
with mock.patch.object(sys, 'path', [str(REPO / 'scripts'), *sys.path]):
    setup = load('portable_setup', 'scripts/portable_setup.py')


class DistributionArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        # macOS may expose the system temp path through /var, itself a symlink.
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / 'source'
        self.source.mkdir()
        for name in build.FILES:
            source_name = build.SOURCE_MAP.get(name, name)
            target = self.source / source_name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / source_name, target)

    def tearDown(self):
        self.temporary.cleanup()

    def test_allowlist_readback_and_reproducibility_ignore_fake_secrets(self):
        for name in ('.git/config', '.codex/auth.json', 'logs/history.txt', 'scripts/private.env', 'src/secret.json'):
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('SYNTHETIC_PRIVATE_VALUE')
        first, second = self.root / 'first.zip', self.root / 'second.zip'
        digest = build.build(self.source, first)
        self.assertEqual(digest, build.build(self.source, second))
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(digest, build.readback(first))
        with zipfile.ZipFile(first) as archive:
            self.assertEqual(archive.namelist(), list(build.FILES) + [build.MANIFEST])
            manifest = json.loads(archive.read(build.MANIFEST))
            for name in build.FILES:
                self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(), manifest['sha256'][name])
                self.assertNotIn(b'SYNTHETIC_PRIVATE_VALUE', archive.read(name))

    def test_archive_tampering_and_extra_members_are_rejected(self):
        target = self.root / 'invalid.zip'
        with zipfile.ZipFile(target, 'w') as archive:
            for name in build.FILES:
                data = b'changed' if name == 'LICENSE' else (self.source / build.SOURCE_MAP.get(name, name)).read_bytes()
                archive.writestr(*build.entry(name, data))
            hashes = {name: hashlib.sha256((self.source / build.SOURCE_MAP.get(name, name)).read_bytes()).hexdigest() for name in build.FILES}
            archive.writestr(*build.entry(build.MANIFEST, json.dumps({'version': 1, 'sha256': hashes}).encode()))
        with self.assertRaises(ValueError):
            build.readback(target)
        with zipfile.ZipFile(target, 'a') as archive:
            archive.writestr('../escape', b'x')
        with self.assertRaises(ValueError):
            build.readback(target)
        for name in ('/absolute', '../outside', 'src/../auth', 'C:/private', 'src\\secret'):
            self.assertFalse(build.safe_name(name), name)

    @unittest.skipIf(os.name == 'nt', 'symlink and hardlink behavior is covered on POSIX')
    def test_links_and_sensitive_allowlisted_content_are_rejected(self):
        target = self.source / 'LICENSE'
        original = target.read_bytes()
        target.unlink()
        target.symlink_to(self.root / 'outside')
        with self.assertRaises(ValueError):
            build.build(self.source, self.root / 'link.zip')
        target.unlink()
        outside = self.root / 'outside'
        outside.write_bytes(original)
        os.link(outside, target)
        with self.assertRaises(ValueError):
            build.build(self.source, self.root / 'hardlink.zip')
        target.unlink()
        target.write_bytes(b'-----BEGIN PRIVATE KEY-----\nfake\n')
        with self.assertRaises(ValueError):
            build.build(self.source, self.root / 'secret.zip')

    def test_static_relative_import_closure_is_allowlisted(self):
        import re
        pending = ['src/model-router.mjs', 'src/codex-bridge.mjs', 'scripts/portable_router.mjs', 'scripts/portable_catalog.mjs']
        visited = set()
        self.assertIn('src/models.json', build.FILES)
        self.assertIn('src/prices.json', build.FILES)
        while pending:
            name = pending.pop()
            if name in visited:
                continue
            visited.add(name)
            self.assertIn(name, build.FILES)
            text = (REPO / name).read_text()
            for dep in re.findall(r"(?:from\s*|import\s*\()\s*['\"](\.{1,2}/[^'\"]+)['\"]", text):
                import posixpath
                child = posixpath.normpath(posixpath.join(posixpath.dirname(name), dep))
                if child.endswith(('.mjs', '.json')):
                    self.assertIn(child, build.FILES, (name, child))
                    if child.endswith('.mjs'):
                        pending.append(child)

    def test_catalog_generator_refusal_does_not_create_file(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('Node is required for this fixture')
        cache = self.root / 'cache.json'
        cache.write_text(json.dumps({'models': [{'slug': 'recipient-gpt', 'base_instructions': 'fixture'}]}))
        seed = json.loads((REPO / 'src/models.json').read_text())['models'][0]['id']
        output = self.root / 'catalog.json'
        result = subprocess.run([node, str(REPO / 'scripts/portable_catalog.mjs'), str(cache), str(output),
                                 'recipient-gpt', seed], input='no\n', capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output.exists())

    @unittest.skipIf(os.name == 'nt', 'native Windows is intentionally unsupported')
    def test_catalog_creation_preserves_cache_and_refuses_unsafe_destinations(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('Node is required for this fixture')
        cache = self.root / 'cache.json'
        cache.write_text(json.dumps({'models': [{'slug': 'recipient-gpt', 'base_instructions': 'fixture'}]}))
        before = cache.read_bytes()
        seed = json.loads((REPO / 'src/models.json').read_text())['models'][0]['id']
        output = self.root / 'catalog.json'

        def generate(destination, source=cache):
            return subprocess.run([node, str(REPO / 'scripts/portable_catalog.mjs'), str(source), str(destination),
                                   'recipient-gpt', seed], input='YES\n', capture_output=True, text=True)

        result = generate(output)
        self.assertEqual(result.returncode, 0, result.stderr)
        content = output.read_bytes()
        catalog = json.loads(content)
        self.assertEqual([m['slug'] for m in catalog['models']], ['recipient-gpt', 'opencode/' + seed])
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        self.assertEqual(cache.read_bytes(), before)
        self.assertNotEqual(generate(output).returncode, 0)
        self.assertEqual(output.read_bytes(), content)
        link = self.root / 'link'
        link.symlink_to(self.root, target_is_directory=True)
        self.assertNotEqual(generate(link / 'unsafe.json').returncode, 0)
        self.assertFalse((self.root / 'unsafe.json').exists())
        source_link = self.root / 'source-link.json'
        source_link.symlink_to(cache)
        self.assertNotEqual(generate(self.root / 'other.json', source_link).returncode, 0)
        self.assertFalse((self.root / 'other.json').exists())

    def test_existing_output_never_overwritten(self):
        output = self.root / 'already.zip'
        output.write_bytes(b'keep')
        with self.assertRaises(FileExistsError):
            build.build(self.source, output)
        self.assertEqual(output.read_bytes(), b'keep')


class PortablePreflightTests(unittest.TestCase):
    def test_os_and_install_form_fixtures(self):
        self.assertEqual([setup.os_kind(x) for x in ('darwin', 'win32', 'linux', 'freebsd')],
                         ['macOS', 'Windows', 'Linux', 'unsupported'])
        self.assertEqual(setup.install_kind('/x/.codex/packages/standalone/current/bin/codex'), 'standalone')
        self.assertEqual(setup.install_kind('C:\\npm\\codex.cmd'), 'npm-or-wrapper')
        self.assertEqual(setup.install_kind('/usr/bin/codex'), 'binary-or-other-wrapper')
        self.assertEqual(setup.install_kind(None), 'missing')

    def test_plans_cover_platforms_dependencies_port_and_conflict(self):
        states = {'home': 'present', 'config': 'present', 'auth': 'present'}
        plan = lambda os_name, **kwargs: setup.make_plan(os_name, kwargs.get('node', (22, 16, 0)),
            kwargs.get('python', (3, 11, 0)), kwargs.get('codex', 'standalone'),
            kwargs.get('states', states), kwargs.get('port', 'no-listener-detected'), kwargs.get('config', 'ok'))
        self.assertTrue(plan('macOS')['ready_for_approval'])
        self.assertTrue(plan('Linux')['ready_for_approval'])
        self.assertFalse(plan('Windows')['ready_for_approval'])
        self.assertFalse(plan('unsupported')['ready_for_approval'])
        for changes in ({'node': None}, {'node': (20, 0, 0)}, {'python': (3, 10, 0)},
                        {'codex': 'missing'}, {'port': 'occupied'}, {'port': 'unknown'},
                        {'states': dict(states, config='unsafe-link')}, {'config': 'conflict'}):
            self.assertFalse(plan('Linux', **changes)['ready_for_approval'], changes)
        self.assertIn('WSL', ' '.join(plan('Windows')['notes']))

    @unittest.skipIf(os.name == 'nt', 'POSIX permission fixture')
    def test_secret_free_read_only_and_unsafe_files_block(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            os.chmod(root, 0o700)
            config, auth = root / 'config.toml', root / 'auth.json'
            config.write_text('model = "SECRET_MODEL_VALUE"\ncustom_key = "SECRET_CONFIG_VALUE"\n')
            auth.write_text('{"token":"SECRET_AUTH_VALUE"}')
            os.chmod(config, 0o600)
            os.chmod(auth, 0o600)
            before = {p: p.read_bytes() for p in (config, auth)}
            with mock.patch.dict(os.environ, {'CODEX_HOME': str(root)}), \
                 mock.patch.object(setup.shutil, 'which', side_effect=lambda n: '/usr/bin/' + n), \
                 mock.patch.object(setup, 'node_version', return_value=(22, 16, 0)), \
                 mock.patch.object(setup, 'port_state', return_value='no-listener-detected'):
                report, _, _, _ = setup.preflight(8788)
            self.assertTrue(report['plan']['ready_for_approval'])
            self.assertNotIn('SECRET_', json.dumps(report))
            self.assertEqual(before, {p: p.read_bytes() for p in before})
            config.write_text('[model_providers.bridge-portable]\nname = "SECRET_CONFIG_VALUE"\n')
            self.assertEqual(setup.config_summary(root, setup.home_states(root))['status'], 'conflict')
            config.unlink()
            config.symlink_to(auth)
            self.assertEqual(setup.home_states(root)['config'], 'unsafe-link')
            config.unlink()
            config.write_text('model="x"\n')
            os.chmod(config, 0o666)
            self.assertEqual(setup.home_states(root)['config'], 'unsafe-permissions')

    def test_clean_environment_and_health_identity(self):
        with mock.patch.dict(os.environ, {'CMD_API_KEY': 'fake', 'OPENAI_API_KEY': 'fake',
                                          'CODEX_BRIDGE_TEST_UPSTREAM': '1', 'UPSTREAM_BASE': 'fake',
                                          'ALLOW_REQUEST_DUMP': '1',
                                          'CODEX_BRIDGE_PORTABLE_LOCAL_TOKEN': 'a' * 64}, clear=False):
            env = setup.clean_env(Path('/chosen-home'))
        for name in ('CMD_API_KEY', 'OPENAI_API_KEY', 'CODEX_BRIDGE_TEST_UPSTREAM', 'UPSTREAM_BASE',
                     'ALLOW_REQUEST_DUMP', 'CODEX_BRIDGE_PORTABLE_LOCAL_TOKEN'):
            self.assertNotIn(name, env)
        child = mock.Mock(pid=42)
        child.poll.return_value = None
        with mock.patch.object(setup.urllib.request, 'urlopen', side_effect=lambda *a, **k: io.BytesIO(b'{"ok":true,"pid":99,"security":"local-owner-v1"}')), \
             mock.patch.object(setup.time, 'sleep'):
            self.assertFalse(setup.wait_child(child, 1234))
        with mock.patch.object(setup.urllib.request, 'urlopen', return_value=io.BytesIO(b'{"ok":true,"pid":42,"security":"local-owner-v1"}')):
            self.assertTrue(setup.wait_child(child, 1234))

    def test_unified_refusal_never_starts_or_reads_key(self):
        args = mock.Mock(port=18790, provider='unified')
        with mock.patch('builtins.input', return_value='no'), \
             mock.patch.object(setup, 'catalog_info') as catalog, \
             mock.patch.object(setup.getpass, 'getpass') as key, \
             mock.patch.object(setup.subprocess, 'Popen') as process, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(setup.run_session(args, 'node', 'codex', Path('.')), 1)
        catalog.assert_not_called()
        key.assert_not_called()
        process.assert_not_called()

    @unittest.skipIf(os.name == 'nt', 'native Windows is intentionally unsupported')
    def test_catalog_fd_read_refuses_replacement_and_unsafe_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            catalog = root / 'catalog.json'
            content = json.dumps({'models': [{'slug': 'recipient-gpt', 'router_provider': 'openai'}]})
            catalog.write_text(content)
            catalog.chmod(0o600)
            args = mock.Mock(catalog=str(catalog), model='recipient-gpt', summary_model='recipient-gpt')
            self.assertEqual(setup.catalog_info(args), (catalog, {'openai'}))
            outside = root / 'other.json'
            outside.write_text(content)
            outside.chmod(0o600)
            original_open = os.open

            def swap(path, flags):
                catalog.unlink()
                catalog.symlink_to(outside)
                return original_open(path, flags)

            with mock.patch.object(setup.os, 'open', side_effect=swap) as opened:
                with self.assertRaises((OSError, ValueError)):
                    setup.catalog_info(args)
                opened.assert_called_once()
            catalog.unlink()
            for content in ('x' * (1024 * 1024 + 1), '[]', '{"models":[{"slug":[],"router_provider":"openai"}]}'):
                catalog.write_text(content)
                catalog.chmod(0o600)
                with self.assertRaises(ValueError):
                    setup.catalog_info(args)

    def test_catalog_change_after_approval_stops_before_auth_or_launch(self):
        args = mock.Mock(port=18790, provider='unified')
        with mock.patch('builtins.input', return_value='YES'), \
             mock.patch.object(setup, 'preflight', return_value=({'plan': {'ready_for_approval': True}}, None, None, None)), \
             mock.patch.object(setup, 'catalog_info', side_effect=ValueError('SYNTHETIC_SECRET')), \
             mock.patch.object(setup.subprocess, 'run') as doctor, \
             mock.patch.object(setup.subprocess, 'Popen') as process, \
             mock.patch.object(setup.getpass, 'getpass') as key, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(setup.run_session(args, 'node', 'codex', Path('.')), 1)
        self.assertIn('rerun preview', output.getvalue())
        self.assertNotIn('SYNTHETIC_SECRET', output.getvalue())
        doctor.assert_not_called()
        process.assert_not_called()
        key.assert_not_called()

    def test_refusal_of_approval_never_starts_process_or_reads_key(self):
        args = mock.Mock(port=8788, model='recipient-choice', provider='opencode-go')
        with mock.patch('builtins.input', return_value='no'), \
             mock.patch.object(setup.getpass, 'getpass') as key, \
             mock.patch.object(setup.subprocess, 'Popen') as process, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(setup.run_session(args, 'node', 'codex', Path('.')), 1)
        key.assert_not_called()
        process.assert_not_called()

    def test_unified_approved_uses_catalog_override_and_isolated_processes(self):
        args = mock.Mock(port=18790, bridge_port=18788, model='opencode/recipient-choice',
                         summary_model='recipient-gpt', provider='unified')
        launches = []
        def spawn(command, **kwargs):
            child = mock.Mock(pid=100 + len(launches))
            child.poll.return_value = None
            launches.append((command, kwargs['env'].copy(), child))
            return child
        with mock.patch('builtins.input', return_value='YES'), \
             mock.patch.object(setup, 'preflight', return_value=({'plan': {'ready_for_approval': True}}, None, None, None)), \
             mock.patch.object(setup, 'catalog_info', return_value=(Path('/recipient/📦/catalog.json'), {'openai', 'opencode'})), \
             mock.patch.object(setup, 'port_state', return_value='no-listener-detected'), \
             mock.patch.object(setup, 'wait_child', return_value=True), \
             mock.patch.object(setup.getpass, 'getpass', return_value='SYNTHETIC_KEY'), \
             mock.patch.object(setup.subprocess, 'run', return_value=mock.Mock(returncode=0)), \
             mock.patch.object(setup.subprocess, 'Popen', side_effect=spawn), \
             mock.patch.object(setup.subprocess, 'call', return_value=0) as codex, \
             mock.patch.object(setup, 'ensure_bridge_key') as ensure_key, \
             mock.patch.dict(os.environ, {'OLLAMA_API_KEY': 'fake', 'UPSTREAM_BASE': 'fake',
                                          'CODEX_BRIDGE_PORTABLE_LOCAL_TOKEN': 'a' * 64}), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(setup.run_session(args, '/bin/node', '/bin/codex', Path('/chosen-home')), 0)
        self.assertEqual(len(launches), 2)
        self.assertEqual(launches[0][1]['OPENCODE_API_KEY'], 'SYNTHETIC_KEY')
        self.assertNotIn('OPENCODE_API_KEY', launches[1][1])
        ensure_key.assert_called_once_with(Path('/chosen-home'))
        self.assertNotIn('CODEX_BRIDGE_PORTABLE_LOCAL_TOKEN', launches[0][1])
        self.assertNotIn('CODEX_BRIDGE_PORTABLE_LOCAL_TOKEN', launches[1][1])
        self.assertNotIn('CODEX_BRIDGE_PORTABLE_LOCAL_TOKEN', codex.call_args.kwargs['env'])
        self.assertNotIn('OLLAMA_API_KEY', launches[0][1])
        self.assertNotIn('UPSTREAM_BASE', codex.call_args.kwargs['env'])
        import tomllib
        setting = next(x for x in codex.call_args.args[0] if x.startswith('model_catalog_json='))
        self.assertEqual(tomllib.loads(setting)['model_catalog_json'], '/recipient/📦/catalog.json')
        self.assertIn('recipient-gpt', launches[1][0])
        for _, _, child in launches:
            child.terminate.assert_called_once()

    @unittest.skipIf(os.name == 'nt', 'native Windows is intentionally unsupported')
    def test_unified_key_is_private_stable_and_unsafe_existing_key_blocks_launch(self):
        args = mock.Mock(port=18790, bridge_port=18788, model='opencode/model',
                         summary_model='recipient-gpt', provider='unified')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            path = root / 'bridge-local-token'
            setup.ensure_bridge_key(root)
            original = path.read_bytes()
            self.assertRegex(original.decode().strip(), r'^[a-f0-9]{64}$')
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            setup.ensure_bridge_key(root)
            self.assertEqual(path.read_bytes(), original)
            path.chmod(0o644)
            with mock.patch('builtins.input', return_value='YES'), \
                 mock.patch.object(setup, 'preflight', return_value=({'plan': {'ready_for_approval': True}}, None, None, None)), \
                 mock.patch.object(setup, 'catalog_info', return_value=(root / 'catalog.json', {'openai', 'opencode'})), \
                 mock.patch.object(setup, 'port_state', return_value='no-listener-detected'), \
                 mock.patch.object(setup.getpass, 'getpass', return_value='SYNTHETIC_KEY'), \
                 mock.patch.object(setup.subprocess, 'run', return_value=mock.Mock(returncode=0)), \
                 mock.patch.object(setup.subprocess, 'Popen') as process, \
                 contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(setup.run_session(args, '/bin/node', '/bin/codex', root), 1)
            process.assert_not_called()
            self.assertIn('unsafe or unavailable', output.getvalue())
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)

    def test_approved_session_scopes_key_and_applies_only_temporary_options(self):
        args = mock.Mock(port=18788, model='recipient-choice', provider='opencode-go')
        child = mock.Mock()
        child.stdout = io.StringIO('bridge codex-bridge listening on http://127.0.0.1:18788\n')
        child.poll.return_value = None
        launches = []

        def spawn(command, **kwargs):
            launches.append((command, kwargs['env'].copy()))
            return child

        health = io.BytesIO(b'{"ok":true,"security":"local-owner-v1"}')
        with mock.patch('builtins.input', return_value='YES'), \
             mock.patch.object(setup, 'preflight', return_value=({'plan': {'ready_for_approval': True}}, None, None, None)), \
             mock.patch.object(setup.getpass, 'getpass', return_value='SYNTHETIC_KEY'), \
             mock.patch.object(setup.subprocess, 'run', return_value=mock.Mock(returncode=0)), \
             mock.patch.object(setup.subprocess, 'Popen', side_effect=spawn), \
             mock.patch.object(setup.subprocess, 'call', return_value=0) as codex, \
             mock.patch.object(setup, 'wait_child', return_value=True), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(setup.run_session(args, '/bin/node', '/bin/codex', Path('/chosen-home')), 0)
        self.assertEqual(launches[0][1]['OPENCODE_API_KEY'], 'SYNTHETIC_KEY')
        self.assertEqual(launches[0][1]['CODEX_BRIDGE_NO_USAGE'], '1')
        self.assertEqual(launches[0][1]['DISABLE_DUMP'], '1')
        self.assertNotIn('OPENCODE_API_KEY', codex.call_args.kwargs['env'])
        self.assertEqual(codex.call_args.kwargs['env']['CODEX_HOME'], '/chosen-home')
        command = codex.call_args.args[0]
        self.assertIn('recipient-choice', command)
        self.assertIn('model_provider="bridge-portable"', command)
        self.assertNotIn('SYNTHETIC_KEY', output.getvalue())
        child.terminate.assert_called_once()


if __name__ == '__main__':
    unittest.main()
