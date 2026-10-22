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

    def normal_setup(self):
        self.path.write_text('model="opencode/deepseek-v4.1-flash"\n[model_providers.codex-bridge]\n'
                             'name="Codex Bridge"\nbase_url="http://127.0.0.1:8790/v1"\n'
                             'requires_openai_auth=true\nwire_api="responses"\n')
        (self.root / "unified-model-catalog.json").write_text(json.dumps({"models": [
            {"slug": "opencode/deepseek-v4.1-flash", "router_provider": "opencode", "router_transport": "responses"}]}))
        return {"direct_header": "x-codex-bridge-direct", "direct_models": ["opencode/deepseek-v4.1-flash"]}

    def test_new_cli_modes_never_fall_through_to_legacy_on_off(self):
        for mode, function in [("normal-on", "activate_normal"), ("transports", "update_transports")]:
            with mock.patch.object(sys, "argv", ["unified_config.py", mode]), mock.patch.object(
                    unified_config, function) as selected, mock.patch.object(unified_config, "configure") as legacy:
                unified_config.main()
            selected.assert_called_once()
            legacy.assert_not_called()

    def test_transport_migration_keeps_all_native_model_metadata_unchanged(self):
        path = self.root / "unified-model-catalog.json"
        native = {"slug": "gpt-native", "router_provider": "openai", "custom": {"preserve": True}, "context_window": 500000}
        legacy = {"slug": "opencode/hy4-preview", "router_model": "hy4-preview", "router_provider": "opencode"}
        direct = {"slug": "opencode/deepseek-v4.1-flash", "router_model": "deepseek-v4.1-flash", "router_provider": "opencode"}
        path.write_text(json.dumps({"models": [native, legacy, direct], "version": 7}))
        unified_config.update_transports(self.root)
        result = json.loads(path.read_text())
        self.assertEqual(result["version"], 7)
        self.assertEqual(result["models"][0], native)
        self.assertEqual(result["models"][1], {**legacy, "router_transport": "chat"})
        self.assertEqual(result["models"][2], {**direct, "router_transport": "responses"})
        unified_config.update_transports(self.root)
        self.assertEqual(len(list(self.root.glob("unified-model-catalog.json.bak.transports.*"))), 1)

    def test_normal_codex_uses_custom_provider_for_standard_local_compaction(self):
        health = self.normal_setup()
        source = self.path.read_text()
        with mock.patch.object(unified_config, "urlopen", return_value=io.StringIO(json.dumps(health))):
            unified_config.activate_normal(self.root, 8790)
        config = tomllib.loads(self.path.read_text())
        self.assertEqual(config["model_provider"], "codex-bridge")
        self.assertEqual(config["model"], "opencode/deepseek-v4.1-flash")
        self.assertEqual(config["model_providers"]["codex-bridge"]["http_headers"], {"x-codex-bridge-direct": "1"})
        backups = list(self.root.glob("config.toml.bak.normal-direct.*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), source)
        with mock.patch.object(unified_config, "urlopen", return_value=io.StringIO(json.dumps(health))):
            unified_config.activate_normal(self.root, 8790)
        self.assertEqual(len(list(self.root.glob("config.toml.bak.normal-direct.*"))), 1)

    def test_normal_activation_refuses_old_router_native_default_and_custom_provider(self):
        for kind in ["old-router", "native-model", "custom-provider"]:
            self.normal_setup()
            if kind == "native-model":
                self.path.write_text(self.path.read_text().replace('model="opencode/deepseek-v4.1-flash"', 'model="gpt-6.1-sol"'))
            if kind == "custom-provider":
                self.path.write_text('model_provider="custom"\n' + self.path.read_text())
            before = self.path.read_bytes()
            with mock.patch.object(unified_config, "urlopen", return_value=io.StringIO('{}')):
                with self.assertRaises(ValueError):
                    unified_config.activate_normal(self.root, 8790)
            self.assertEqual(self.path.read_bytes(), before)

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

    def test_only_officially_supported_models_use_direct_responses(self):
        slugs = ["deepseek-v4.1-flash", "deepseek-v4-pro", "grok-4.7", "gpt-6-luna", "hy4-preview"]
        (self.root / "models_cache.json").write_text(json.dumps({"models": [{"slug": "gpt-native"}]}))
        (self.root / "model-catalog.json").write_text(json.dumps({"models": [
            {"slug": slug, "router_transport": "responses"} for slug in slugs]}))
        source = self.root / "source"
        (source / "src").mkdir(parents=True)
        (source / "src/models.json").write_text(json.dumps({"models": [{"id": slug} for slug in slugs]}))
        models = json.loads(unified_config.prepare(self.root, source).read_text())["models"]
        routes = {model["slug"]: model.get("router_transport") for model in models}
        self.assertIsNone(routes["gpt-native"])
        for slug in slugs[:-1]:
            self.assertEqual(routes["opencode/" + slug], "responses")
        self.assertEqual(routes["opencode/hy4-preview"], "chat")

    def test_prepare_sanitizes_display_text_and_rejects_bad_ids(self):
        native = {"models": [{"slug": "gpt-test", "display_name": "GPT\u001b[31mX"}]}
        opencode = {"models": [{"slug": "opencode-test", "display_name": "Go\u202eX"}]}
        (self.root / "models_cache.json").write_text(json.dumps(native))
        (self.root / "model-catalog.json").write_text(json.dumps(opencode))
        source = self.root / "source"
        (source / "src").mkdir(parents=True)
        (source / "src/models.json").write_text('{"models":[{"id":"opencode-test"}]}')
        catalog = json.loads(unified_config.prepare(self.root, source).read_text())
        self.assertEqual(catalog["models"][0]["display_name"], "GPTX")
        self.assertEqual(catalog["models"][1]["display_name"], "OpenCode · Go X")

        (self.root / "models_cache.json").write_text(json.dumps({"models": [{"slug": "../evil"}]}))
        with self.assertRaisesRegex(ValueError, "モデルID"):
            unified_config.prepare(self.root, source)


if __name__ == "__main__":
    unittest.main()
