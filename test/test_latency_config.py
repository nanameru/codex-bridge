from pathlib import Path
import sys
import tempfile
import tomllib
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import latency_config


class LatencyConfigTests(unittest.TestCase):
    def test_preserves_connections_tools_and_explicit_model_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'config.toml'
            source = '# keep comment\nmodel="chosen"\nmodel_provider="openai"\n[mcp_servers.example]\ncommand="example"\n[model_providers.bridge]\nbase_url="http://127.0.0.1:8790/v1"\n'
            path.write_text(source)
            self.assertFalse(latency_config.configure(root)['applied'])
            self.assertEqual(path.read_text(), source)
            result = latency_config.configure(root, True)
            self.assertTrue(result['applied'])
            self.assertEqual(tomllib.loads(path.read_text()), {**tomllib.loads(source), **latency_config.DEFAULTS})
            self.assertEqual(Path(result['backup']).read_text(), source)
            self.assertEqual(Path(result['backup']).stat().st_mode & 0o777, 0o600)
            self.assertFalse(latency_config.configure(root, True)['changed'])
            self.assertEqual(len(list(root.glob('config.toml.bak.latency.*'))), 1)

    def test_explicit_threshold_and_scope_are_preserved_including_zero(self):
        for threshold in (0, 64000, 500000):
            with self.subTest(threshold=threshold), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                path = root / 'config.toml'
                source = f'model_auto_compact_token_limit={threshold}\nmodel_auto_compact_token_limit_scope="total"\n'
                path.write_text(source)
                self.assertFalse(latency_config.configure(root, True)['changed'])
                self.assertEqual(path.read_text(), source)

    def test_symlink_config_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'other.toml'
            target.write_text('model="chosen"\n')
            (root / 'config.toml').symlink_to(target)
            with self.assertRaisesRegex(ValueError, 'シンボリック'):
                latency_config.configure(root, True)
            self.assertEqual(target.read_text(), 'model="chosen"\n')
