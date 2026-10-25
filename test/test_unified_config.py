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

    def test_protected_install_never_reenables_a_legacy_unprotected_router(self):
        (self.root / "bridge-local-token").write_text("present")
        before = self.path.read_bytes()
        with mock.patch.object(unified_config, "urlopen", side_effect=self.health):
            with self.assertRaisesRegex(ValueError, "保護版"):
                unified_config.configure(self.root, "on", 8790)
        self.assertEqual(self.path.read_bytes(), before)
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
        for mode, function in [("normal-on", "activate_normal"), ("transports", "update_transports"),
                               ("flash-code-mode", "activate_flash_code_mode")]:
            with mock.patch.object(sys, "argv", ["unified_config.py", mode]), mock.patch.object(
                    unified_config, function) as selected, mock.patch.object(unified_config, "configure") as legacy:
                unified_config.main()
            selected.assert_called_once()
            legacy.assert_not_called()

    def test_flash_code_mode_changes_only_tool_metadata_and_is_idempotent(self):
        self.normal_setup()
        path = self.root / "unified-model-catalog.json"
        catalog = json.loads(path.read_text())
        catalog["models"][0]["base_instructions"] = "preserve"
        catalog["models"].extend([{"slug": "gpt-6.1-sol", "custom": "preserve"},
                                  {"slug": "opencode/deepseek-v4-pro", "tool_mode": None}])
        path.write_text(json.dumps(catalog))
        self.path.write_text('model_provider="codex-bridge"\nmodel_catalog_json=' + json.dumps(str(path))
                             + '\n[model_providers.codex-bridge.http_headers]\nx-codex-bridge-direct="1"\n')
        config_before = self.path.read_bytes()
        unified_config.activate_flash_code_mode(self.root)
        result = json.loads(path.read_text())
        self.assertEqual(result["models"][1:], catalog["models"][1:])
        self.assertEqual(result["models"][0], {**catalog["models"][0], "tool_mode": "code_mode_only",
                                              "supports_search_tool": True, "shell_type": "unified_exec"})
        self.assertEqual(self.path.read_bytes(), config_before)
        backups = list(self.root.glob("unified-model-catalog.json.bak.flash-code-mode.*"))
        self.assertEqual(json.loads(backups[0].read_text()), catalog)
        unified_config.activate_flash_code_mode(self.root)
        self.assertEqual(len(list(self.root.glob("unified-model-catalog.json.bak.flash-code-mode.*"))), 1)
        path.unlink()
        path.symlink_to(backups[0])
        with self.assertRaisesRegex(ValueError, "リンク"):
            unified_config.activate_flash_code_mode(self.root)
        self.assertEqual(json.loads(backups[0].read_text()), catalog)

    def test_flash_code_mode_refuses_non_direct_settings(self):
        self.normal_setup()
        path = self.root / "unified-model-catalog.json"
        before = path.read_bytes()
        with self.assertRaisesRegex(ValueError, "直接接続"):
            unified_config.activate_flash_code_mode(self.root)
        self.assertEqual(path.read_bytes(), before)

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

    def test_common_history_accepts_every_model_and_removes_old_direct_marker(self):
        models = json.loads((ROOT / "src/models.json").read_text())["models"]
        for entry in models:
            with self.subTest(model=entry["id"]):
                self.normal_setup()
                slug = "opencode/" + entry["id"]
                self.path.write_text(self.path.read_text().replace("opencode/deepseek-v4.1-flash", slug)
                                     + '[model_providers.codex-bridge.http_headers]\nx-codex-bridge-direct="1"\n')
                (self.root / "unified-model-catalog.json").write_text(json.dumps({"models": [
                    {"slug": slug, "router_provider": "opencode", "router_transport": "chat"}]}))
                health = {"history_transport": "chat", "model_ids": [slug]}
                with mock.patch.object(unified_config, "urlopen", return_value=io.StringIO(json.dumps(health))):
                    unified_config.activate_normal(self.root, 8790)
                result = tomllib.loads(self.path.read_text())
                self.assertEqual(result["model"], slug)
                self.assertEqual(result["model_provider"], "codex-bridge")
                self.assertNotIn("x-codex-bridge-direct", result["model_providers"]["codex-bridge"]["http_headers"])

    def test_normal_activation_keeps_gpt_default_and_routes_both_model_choices(self):
        self.normal_setup()
        self.catalog = {"models": [
            {"slug": "gpt-6.1-sol", "router_provider": "openai"},
            {"slug": "opencode/deepseek-v4.1-flash", "router_provider": "opencode", "router_transport": "responses"},
        ]}
        (self.root / "unified-model-catalog.json").write_text(json.dumps(self.catalog))
        self.path.write_text('model="gpt-6.1-sol"\nmodel_provider="openai"\n# preserve\n'
                             '[profiles.work]\nmodel="profile"\n' + self.path.read_text().split("\n", 1)[1])
        original = tomllib.loads(self.path.read_text())
        with mock.patch.object(unified_config, "urlopen", side_effect=self.health):
            unified_config.activate_normal(self.root, 8790)
            first = self.path.read_text()
            unified_config.activate_normal(self.root, 8790)
        data = tomllib.loads(first)
        self.assertEqual(self.path.read_text(), first)
        self.assertEqual(data["model"], "gpt-6.1-sol")
        self.assertEqual(data["model_provider"], "openai")
        self.assertEqual(data["openai_base_url"], "http://127.0.0.1:8790/v1")
        self.assertEqual(data["model_catalog_json"], str(self.root / "unified-model-catalog.json"))
        self.assertEqual(data["profiles"], original["profiles"])
        self.assertIn("# preserve", first)
        self.assertEqual(len(list(self.root.glob("config.toml.bak.unified.*"))), 1)
        unified_config.configure(self.root, "off", 8790)
        self.assertEqual(tomllib.loads(self.path.read_text()), original)

    def test_legacy_switch_restores_missing_native_route_in_unified_mode(self):
        with mock.patch.object(unified_config, "urlopen", side_effect=self.health):
            unified_config.configure(self.root, "on", 8790)
        self.path.write_text(unified_config.edit_table(self.path.read_text(), (), {"openai_base_url": None}))
        for mode in ["repair", "on", "off"]:
            switch_config.switch(mode, self.root)
            self.assertEqual(tomllib.loads(self.path.read_text())["openai_base_url"], "http://127.0.0.1:8790/v1")
        self.assertEqual(tomllib.loads(self.path.read_text())["model"], "gpt-test")

    def test_unified_switch_never_points_native_auth_at_a_remote_bridge(self):
        with mock.patch.object(unified_config, "urlopen", side_effect=self.health):
            unified_config.configure(self.root, "on", 8790)
        for url in ["https://remote.example/v1", "http://user:secret@127.0.0.1:8790/v1",
                    "http://127.0.0.1:8790/v1?redirect=1", "http://127.0.0.1:8790/other"]:
            self.path.write_text(unified_config.edit_table(self.path.read_text(), unified_config.BRIDGE_TABLE, {"base_url": url}))
            before = self.path.read_bytes()
            with self.assertRaisesRegex(ValueError, "loopback"):
                switch_config.switch("repair", self.root)
            self.assertEqual(self.path.read_bytes(), before)

    def test_gpt_activation_refuses_wrong_catalog_and_custom_provider(self):
        self.catalog["models"][0]["router_provider"] = "openai"
        (self.root / "unified-model-catalog.json").write_text(json.dumps(self.catalog))
        before = self.path.read_bytes()
        with mock.patch.object(unified_config, "urlopen", return_value=io.StringIO('{"mode":"unified","model_ids":[]}')):
            with self.assertRaisesRegex(ValueError, "カタログ"):
                unified_config.activate_normal(self.root, 8790)
        self.assertEqual(self.path.read_bytes(), before)
        self.path.write_text('model_provider="custom"\n' + self.path.read_text())
        before = self.path.read_bytes()
        with mock.patch.object(unified_config, "urlopen") as fetch:
            with self.assertRaisesRegex(ValueError, "独自"):
                unified_config.activate_normal(self.root, 8790)
            fetch.assert_not_called()
        self.assertEqual(self.path.read_bytes(), before)

    def test_gpt_activation_preserves_a_concurrent_model_change(self):
        self.catalog["models"][0]["router_provider"] = "openai"
        (self.root / "unified-model-catalog.json").write_text(json.dumps(self.catalog))
        newer = self.path.read_text().replace('model="gpt-test"', 'model="new-choice"')

        def changing_health(*args, **kwargs):
            self.path.write_text(newer)
            return self.health(*args, **kwargs)

        with mock.patch.object(unified_config, "urlopen", side_effect=changing_health):
            with self.assertRaisesRegex(ValueError, "変更"):
                unified_config.activate_normal(self.root, 8790)
        self.assertEqual(self.path.read_text(), newer)
        self.assertFalse((self.root / "unified-router-state.json").exists())

    def test_normal_activation_refuses_old_router_unknown_model_and_custom_provider(self):
        for kind in ["old-router", "unknown-model", "custom-provider"]:
            self.normal_setup()
            if kind == "unknown-model":
                self.path.write_text(self.path.read_text().replace('model="opencode/deepseek-v4.1-flash"', 'model="unknown-model"'))
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

    def test_shared_cache_manual_and_auto_models_never_become_native(self):
        native = {"models": [{"slug": "gpt-test"}] + [{"slug": prefix + "/deepseek-v4.1-flash"}
                    for prefix in ["opencode", "commandcode", "ollama", "auto-commandcode", "auto-ollama"]]}
        (self.root / "models_cache.json").write_text(json.dumps(native))
        (self.root / "model-catalog.json").write_text('{"models":[{"slug":"gpt-test"}]}')
        source = self.root / "source"
        (source / "src").mkdir(parents=True)
        (source / "src/models.json").write_text('{"models":[{"id":"gpt-test"}]}')
        result = json.loads(unified_config.prepare(self.root, source).read_text())
        self.assertEqual([m["slug"] for m in result["models"]], ["gpt-test", "opencode/gpt-test"])

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
