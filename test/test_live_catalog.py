import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import tomllib

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import live_catalog as lc
import unified_config


class LiveCatalogConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = self.root / "config.toml"
        self.source = ('# keep comment\nmodel="gpt-test"\nmodel_provider="openai"\n'
                       'model_catalog_json="/old/catalog.json"\nopenai_base_url="http://127.0.0.1:8791/v1"\n'
                       '[features]\ngoals=true\n[model_providers.other]\nname="Other"\n')
        self.config.write_text(self.source)

    def test_migration_preserves_model_features_other_providers_and_comments(self):
        result = lc.candidate(self.source)
        data = tomllib.loads(result)
        self.assertEqual(data["model"], "gpt-test")
        self.assertEqual(data["model_provider"], "codex-live")
        self.assertNotIn("model_catalog_json", data)
        self.assertTrue(data["features"]["goals"])
        self.assertEqual(data["model_providers"]["other"]["name"], "Other")
        self.assertTrue(data["model_providers"]["codex-live"]["requires_openai_auth"])
        self.assertIn("# keep comment", result)
        self.assertEqual(lc.candidate(result), result)

    def test_apply_is_private_and_exact_restore_is_possible(self):
        health = mock.MagicMock()
        health.__enter__.return_value.read.return_value = b'{"live_catalog":true}'
        with mock.patch.object(lc, "urlopen", return_value=health):
            self.assertEqual(lc.apply(self.root), "applied")
        state = self.root / "live-catalog-state.json"
        self.assertEqual(state.stat().st_mode & 0o777, 0o600)
        self.assertEqual(lc.apply(self.root), "unchanged")
        self.assertEqual(lc.apply(self.root, restore=True), "restored")
        self.assertEqual(self.config.read_text(), self.source)

    def test_custom_provider_and_edited_config_are_not_overwritten(self):
        changed = lc.candidate(self.source).replace('name = "OpenAI"', 'name = "Custom"')
        with self.assertRaises(ValueError):
            lc.candidate(changed)
        result = lc.candidate(self.source)
        (self.root / "live-catalog-state.json").write_text(json.dumps({"original": self.source, "applied": result}))
        self.config.write_text(result + "\n# new change\n")
        with self.assertRaises(ValueError):
            lc.apply(self.root, restore=True)
        self.assertTrue(self.config.read_text().endswith("# new change\n"))

    def test_unhealthy_runtime_and_symlinks_leave_config_untouched(self):
        health = mock.MagicMock()
        health.__enter__.return_value.read.return_value = b'{"live_catalog":false}'
        with mock.patch.object(lc, "urlopen", return_value=health), self.assertRaises(ValueError):
            lc.apply(self.root)
        self.assertEqual(self.config.read_text(), self.source)
        victim = self.root / "victim"
        victim.write_text(self.source)
        self.config.unlink()
        self.config.symlink_to(victim)
        with self.assertRaises(ValueError):
            lc.apply(self.root)
        self.assertEqual(victim.read_text(), self.source)

    def test_failed_atomic_config_write_removes_pending_state(self):
        health = mock.MagicMock()
        health.__enter__.return_value.read.return_value = b'{"live_catalog":true}'
        original = lc.atomic_write
        def write(path, value):
            if path == self.config:
                raise OSError("test write failure")
            original(path, value)
        with mock.patch.object(lc, "urlopen", return_value=health), mock.patch.object(lc, "atomic_write", side_effect=write), self.assertRaises(OSError):
            lc.apply(self.root)
        self.assertEqual(self.config.read_text(), self.source)
        self.assertFalse((self.root / "live-catalog-state.json").exists())

    def test_static_prepare_does_not_treat_live_opencode_cache_entries_as_native(self):
        native = {"models": [{"slug": "gpt-test"}, {"slug": "opencode/stale"}]}
        (self.root / "models_cache.json").write_text(json.dumps(native))
        (self.root / "model-catalog.json").write_text(json.dumps({"models": [{"slug": "old"}]}))
        source = self.root / "source"
        (source / "src").mkdir(parents=True)
        (source / "src/models.json").write_text(json.dumps({"models": [{"id": "old"}]}))
        path = unified_config.prepare(self.root, source)
        models = json.loads(path.read_text())["models"]
        self.assertEqual({m["slug"] for m in models}, {"gpt-test", "opencode/old"})
        self.assertEqual(next(m for m in models if m["slug"] == "gpt-test")["router_provider"], "openai")
        self.assertEqual(json.loads((self.root / "models_cache.json").read_text()), native)
        (self.root / "models_cache.json").write_text(json.dumps({"models": [{"slug": "opencode/stale"}]}))
        with self.assertRaises(ValueError):
            unified_config.prepare(self.root, source)


if __name__ == "__main__":
    unittest.main()
