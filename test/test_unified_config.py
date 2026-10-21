import io
import json
from pathlib import Path
import sys
import tempfile
import tomllib
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import unified_config
import switch_config
import install_router_service


class UnifiedConfigTests(unittest.TestCase):
    def test_waits_for_active_conversations_without_stopping_them(self):
        with mock.patch.object(install_router_service.subprocess, "run") as run, mock.patch.object(
            install_router_service.time, "sleep"
        ) as sleep:
            run.side_effect = [mock.Mock(returncode=0), mock.Mock(returncode=0), mock.Mock(returncode=1)]
            install_router_service.wait_for_idle(30)
            self.assertEqual(run.call_count, 3)
            self.assertEqual(sleep.call_count, 2)
            self.assertTrue(all(call.args[0][0] == "lsof" for call in run.call_args_list))

    def test_refuses_a_busy_or_unreadable_connection_state(self):
        for status in [0, 2]:
            with mock.patch.object(install_router_service.subprocess, "run", return_value=mock.Mock(returncode=status)), mock.patch.object(
                install_router_service.time, "sleep"
            ) as sleep:
                with self.assertRaises(SystemExit):
                    install_router_service.wait_for_idle(0)
                sleep.assert_not_called()

    def test_waits_until_old_launchd_registration_is_removed(self):
        with mock.patch.object(install_router_service.subprocess, "run") as run, mock.patch.object(
            install_router_service.time, "sleep"
        ) as sleep:
            run.side_effect = [mock.Mock(returncode=0), mock.Mock(returncode=0), mock.Mock(returncode=1)]
            install_router_service.wait_for_unload("gui/test/router")
            self.assertEqual(run.call_count, 3)
            self.assertEqual(sleep.call_count, 3)

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.path = self.root / "config.toml"
        self.path.write_text('model="gpt-test"\n# preserve\n[profiles.work]\nmodel="profile"\n[model_providers.codex-bridge]\nname="Existing"\nbase_url="http://127.0.0.1:8788/v1"\nwire_api="responses"\n')
        self.catalog = {"models": [{"slug": "gpt-test"}, {"slug": "opencode/deepseek-test"}]}
        (self.root / "unified-model-catalog.json").write_text(json.dumps(self.catalog))

    def health(self, *_arguments, **_keywords):
        return io.StringIO(json.dumps({"mode": "unified", "model_ids": [model["slug"] for model in self.catalog["models"]]}))

    def test_round_trip_and_legacy_switch_preserve_models_and_settings(self):
        original = tomllib.loads(self.path.read_text())
        with mock.patch.object(unified_config, "urlopen", side_effect=self.health):
            unified_config.configure(self.root, "on", 8790)
            first = self.path.read_text()
            unified_config.configure(self.root, "on", 8790)
        self.assertEqual(self.path.read_text(), first)
        data = tomllib.loads(first)
        self.assertEqual(data["openai_base_url"], "http://127.0.0.1:8790/v1")
        self.assertTrue(data["model_providers"]["codex-bridge"]["requires_openai_auth"])
        with mock.patch.dict(switch_config.os.environ, {"DEFAULT_MODEL": "deepseek-test"}):
            switch_config.switch("on", self.root)
        self.assertEqual(tomllib.loads(self.path.read_text())["model"], "opencode/deepseek-test")
        self.assertEqual(tomllib.loads(self.path.read_text())["model_catalog_json"], str(self.root / "unified-model-catalog.json"))
        switch_config.switch("off", self.root)
        self.assertEqual(tomllib.loads(self.path.read_text())["model_catalog_json"], str(self.root / "unified-model-catalog.json"))
        unified_config.configure(self.root, "off", 8790)
        self.assertEqual(tomllib.loads(self.path.read_text()), original)
        self.assertIn("# preserve", self.path.read_text())

    def test_refuses_a_different_catalog_without_changing_config(self):
        original = self.path.read_bytes()
        with mock.patch.object(unified_config, "urlopen", return_value=io.StringIO('{"mode":"unified","model_ids":[]}')):
            with self.assertRaisesRegex(ValueError, "カタログ"):
                unified_config.configure(self.root, "on", 8790)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertFalse((self.root / "unified-router-state.json").exists())

    def test_refuses_custom_provider_credentials(self):
        self.path.write_text(self.path.read_text() + 'env_key="OTHER_KEY"\n')
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, "独自認証"):
            unified_config.configure(self.root, "on", 8790)
        self.assertEqual(self.path.read_bytes(), before)

    def test_preserves_multiline_content_and_quoted_provider_name(self):
        source = 'instructions="""\n[model_providers.codex-bridge]\nbase_url="text"\n"""\n[model_providers."codex-bridge"]\nbase_url="old"\n'
        result = unified_config.edit_table(source, unified_config.BRIDGE_TABLE, {"base_url": "new"})
        before = tomllib.loads(source)
        after = tomllib.loads(result)
        self.assertEqual(after["instructions"], before["instructions"])
        self.assertEqual(after["model_providers"]["codex-bridge"]["base_url"], "new")

    def test_prepares_namespaced_catalog_without_overwriting_sources(self):
        native = {"models": [{"slug": "gpt-test", "display_name": "GPT"}]}
        opencode = {"models": [{"slug": "gpt-test", "display_name": "Go GPT"}]}
        (self.root / "models_cache.json").write_text(json.dumps(native))
        (self.root / "model-catalog.json").write_text(json.dumps(opencode))
        source = self.root / "source"
        (source / "src").mkdir(parents=True)
        (source / "src/models.json").write_text('{"models":[{"id":"gpt-test"}]}')
        path = unified_config.prepare(self.root, source)
        catalog = json.loads(path.read_text())
        self.assertEqual([model["slug"] for model in catalog["models"]], ["gpt-test", "opencode/gpt-test"])
        self.assertEqual(json.loads((self.root / "models_cache.json").read_text()), native)
        self.assertEqual(json.loads((self.root / "model-catalog.json").read_text()), opencode)

    def test_pins_frequent_models_at_top_without_reordering_the_rest(self):
        native = {"models": [{"slug": "gpt-other", "display_name": "Other"},
                            {"slug": "gpt-6.1-sol", "display_name": "GPT-6.1-Sol"}]}
        opencode = {"models": [{"slug": "deepseek-v4.1-flash", "display_name": "DeepSeek V4.1 Flash"},
                              {"slug": "glm-5.3", "display_name": "GLM-5.3"}]}
        (self.root / "models_cache.json").write_text(json.dumps(native))
        (self.root / "model-catalog.json").write_text(json.dumps(opencode))
        source = self.root / "source"
        (source / "src").mkdir(parents=True)
        (source / "src/models.json").write_text(json.dumps({"models": [
            {"id": "gpt-6.1-sol"}, {"id": "deepseek-v4.1-flash"}, {"id": "glm-5.3"},
        ]}))
        catalog = json.loads(unified_config.prepare(self.root, source).read_text())
        self.assertEqual([model["slug"] for model in catalog["models"]], [
            "opencode/deepseek-v4.1-flash", "gpt-6.1-sol", "gpt-other", "opencode/glm-5.3",
        ])
        self.assertEqual([model["priority"] for model in catalog["models"]], [1, 1, 2, 3])

    def test_prioritize_handles_a_missing_pinned_model(self):
        models = [{"slug": "gpt-other"}, {"slug": "opencode/deepseek-v4.1-flash"}]
        result = unified_config.prioritize(models)
        self.assertEqual([model["slug"] for model in result],
                         ["opencode/deepseek-v4.1-flash", "gpt-other"])
        self.assertEqual([model["priority"] for model in result], [1, 2])


if __name__ == "__main__":
    unittest.main()
