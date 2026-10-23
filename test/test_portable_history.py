import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import portable_history as ph


class PortableHistoryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / "config.toml"
        self.source = ('# preserve\nmodel="gpt-test"\nmodel_provider="openai"\nmodel_catalog_json='
                       + json.dumps(str(self.root / "unified-model-catalog.json")) + '\n'
                       '[profiles.other]\nmodel="other"\n[model_providers.codex-bridge]\n'
                       'name="Codex Bridge"\nbase_url="http://127.0.0.1:8790/v1"\n'
                       'requires_openai_auth=true\nwire_api="responses"\n'
                       '[model_providers.codex-bridge.http_headers]\nx-codex-bridge-direct="1"\n'
                       'x-preserve="private-test-value"\n[model_providers.codex-bridge.capabilities]\n'
                       'external_web_access=false\nremote_compaction="v2"\n')
        self.write(self.source)
        source_models = json.loads((Path(__file__).resolve().parents[1] / "src/models.json").read_text())["models"]
        models = [{"slug": "gpt-test", "router_provider": "openai"}] + [
            {"slug": "opencode/" + m["id"], "router_provider": "opencode"} for m in source_models]
        (self.root / "unified-model-catalog.json").write_text(json.dumps({"models": models}))

    def write(self, text):
        self.path.write_text(text)
        self.path.chmod(0o600)

    def test_preview_does_not_write_or_contact_services(self):
        with mock.patch.object(ph, "verify_runtime") as verify:
            report = ph.configure(self.root)
        self.assertEqual(report["mode"], "preview")
        self.assertTrue(report["changed"])
        self.assertEqual(self.path.read_text(), self.source)
        self.assertEqual(list(self.root.glob(ph.BACKUP_PREFIX + "*")), [])
        verify.assert_not_called()

    def test_apply_preserves_model_auth_profiles_and_other_capabilities(self):
        with mock.patch.object(ph, "verify_runtime"):
            report = ph.configure(self.root, apply=True)
            second = ph.configure(self.root, apply=True)
        result = tomllib.loads(self.path.read_text())
        original = tomllib.loads(self.source)
        self.assertEqual(result["model"], "gpt-test")
        self.assertEqual(result["model_provider"], ph.PROVIDER)
        self.assertEqual(result["profiles"], original["profiles"])
        provider = result["model_providers"][ph.PROVIDER]
        self.assertEqual(provider["capabilities"], {"external_web_access": False, "remote_compaction": "unsupported"})
        self.assertEqual(provider["http_headers"], {"x-preserve": "private-test-value"})
        self.assertTrue(provider["requires_openai_auth"])
        self.assertEqual(Path(report["backup"]).read_text(), self.source)
        self.assertEqual(Path(report["backup"]).stat().st_mode & 0o777, 0o600)
        self.assertFalse(second["changed"])
        self.assertEqual(len(list(self.root.glob(ph.BACKUP_PREFIX + "*"))), 1)

    def test_restore_requires_unchanged_applied_config(self):
        with mock.patch.object(ph, "verify_runtime"):
            report = ph.configure(self.root, apply=True)
        applied = self.path.read_text()
        self.assertTrue(ph.configure(self.root, restore=report["backup"])["changed"])
        self.assertEqual(self.path.read_text(), applied)
        self.write(applied + '\n# concurrent change\n')
        with self.assertRaisesRegex(ValueError, "変更"):
            ph.configure(self.root, apply=True, restore=report["backup"])
        self.write(applied)
        ph.configure(self.root, apply=True, restore=report["backup"])
        self.assertEqual(self.path.read_text(), self.source)

    def test_all_catalog_models_keep_their_selection(self):
        for model in [m["slug"] for m in ph.read_catalog(self.root)]:
            self.write(self.source.replace('model="gpt-test"', 'model=' + json.dumps(model), 1))
            with mock.patch.object(ph, "verify_runtime"):
                ph.configure(self.root, apply=True)
            self.assertEqual(tomllib.loads(self.path.read_text())["model"], model)

    def test_refuses_custom_provider_endpoint_credentials_and_unknown_marker(self):
        variants = [self.source.replace('model_provider="openai"', 'model_provider="custom"'),
                    self.source.replace('http://127.0.0.1:8790/v1', 'https://example.org/v1'),
                    self.source.replace('wire_api="responses"', 'wire_api="responses"\nenv_key="CUSTOM"'),
                    self.source.replace('x-codex-bridge-direct="1"', 'x-codex-bridge-direct="unknown"')]
        for source in variants:
            self.write(source)
            with self.assertRaises(ValueError):
                ph.configure(self.root, apply=True)
            self.assertEqual(self.path.read_text(), source)

    def test_refuses_symlinks_and_public_config(self):
        self.path.chmod(0o644)
        with self.assertRaises(ValueError):
            ph.configure(self.root)
        self.path.chmod(0o600)
        target = self.root / "real-config"
        self.path.rename(target)
        self.path.symlink_to(target)
        with self.assertRaises(OSError):
            ph.configure(self.root)

    def test_conflict_and_unhealthy_runtime_leave_config_unchanged(self):
        with mock.patch.object(ph, "verify_runtime", side_effect=ValueError("unavailable")):
            with self.assertRaises(ValueError):
                ph.configure(self.root, apply=True)
        self.assertEqual(self.path.read_text(), self.source)
        newer = self.source + '\n# newer\n'
        with mock.patch.object(ph, "verify_runtime", side_effect=lambda *_: self.write(newer)):
            with self.assertRaisesRegex(ValueError, "変更"):
                ph.configure(self.root, apply=True)
        self.assertEqual(self.path.read_text(), newer)
        self.assertEqual(list(self.root.glob(ph.BACKUP_PREFIX + "*")), [])

    def test_runtime_requires_supported_version_and_matching_protected_services(self):
        models = ph.read_catalog(self.root)
        health = {"mode": "unified", "model_ids": [m["slug"] for m in models]}
        with mock.patch.object(ph.subprocess, "run", return_value=mock.Mock(stdout="codex-cli 0.163.0")), \
                mock.patch.object(ph, "verify_service", return_value=health) as verify:
            ph.verify_runtime(models, "codex")
            self.assertEqual([c.args[0] for c in verify.call_args_list], [8790, 8788])
        for version in ["codex-cli 0.161.0", "unknown"]:
            with mock.patch.object(ph.subprocess, "run", return_value=mock.Mock(stdout=version)):
                with self.assertRaises(ValueError):
                    ph.verify_runtime(models, "codex")

    def test_cli_never_prints_config_contents_or_secrets(self):
        self.write(self.source + '\nbroken="private-test-secret\n')
        result = subprocess.run([sys.executable, str(Path(ph.__file__))],
                                env={**os.environ, "CODEX_HOME": str(self.root)}, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("private-test-secret", result.stdout + result.stderr)

    def test_refuses_missing_malformed_unknown_and_linked_catalogs(self):
        path = self.root / "unified-model-catalog.json"
        valid = path.read_text()
        invalid = ["not json", "[]", '{"models":[]}',
                   '{"models":[{"slug":"x","router_provider":"unknown"}]}',
                   '{"models":[{"slug":"x","router_provider":"openai"},{"slug":"x","router_provider":"openai"}]}']
        for value in invalid:
            with self.subTest(value=value):
                path.write_text(value)
                with self.assertRaises(ValueError):
                    ph.configure(self.root, apply=True)
                self.assertEqual(self.path.read_text(), self.source)
        path.unlink()
        with self.assertRaises(ValueError):
            ph.configure(self.root)
        target = self.root / "catalog-target.json"
        target.write_text(valid)
        path.symlink_to(target)
        with self.assertRaises(ValueError):
            ph.configure(self.root)

    def test_refuses_invalid_provider_shapes_and_missing_model(self):
        models = ph.read_catalog(self.root)
        parsed = tomllib.loads(self.source)
        for providers in ["unexpected", {ph.PROVIDER: "unexpected"}, {}]:
            source = self.source.split("[model_providers.codex-bridge]", 1)[0]
            if isinstance(providers, str):
                source = 'model_providers="unexpected"\n' + source
            elif providers:
                source += '[model_providers]\ncodex-bridge="unexpected"\n'
            with self.assertRaises(ValueError):
                ph.candidate_config(source, self.root, models)
        for field in ["http_headers", "capabilities"]:
            source = self.source.split("[model_providers.codex-bridge.http_headers]", 1)[0]
            source += field + '="unexpected"\n'
            with self.assertRaises(ValueError):
                ph.candidate_config(source, self.root, models)
        with self.assertRaises(ValueError):
            ph.candidate_config(self.source.replace('model="gpt-test"', 'model="unknown"'), self.root, models)

    def test_noop_apply_does_not_create_backup_or_contact_runtime(self):
        configured = ph.candidate_config(self.source, self.root, ph.read_catalog(self.root))
        self.write(configured)
        with mock.patch.object(ph, "verify_runtime") as runtime:
            result = ph.configure(self.root, apply=True)
        self.assertFalse(result["changed"])
        runtime.assert_not_called()
        self.assertEqual(list(self.root.glob(ph.BACKUP_PREFIX + "*")), [])

    def test_catalog_mismatch_and_old_security_are_not_applied(self):
        models = ph.read_catalog(self.root)
        for health in [{"mode": "unified", "model_ids": []},
                       {"mode": "legacy", "model_ids": [m["slug"] for m in models]}]:
            with mock.patch.object(ph.subprocess, "run", return_value=mock.Mock(stdout="codex-cli 0.163.0")), \
                    mock.patch.object(ph, "verify_service", return_value=health):
                with self.assertRaises(ValueError):
                    ph.configure(self.root, apply=True)
            self.assertEqual(self.path.read_text(), self.source)
        with mock.patch.object(ph.subprocess, "run", return_value=mock.Mock(stdout="codex-cli 0.162.0")), \
                mock.patch.object(ph, "verify_service", side_effect=ValueError("not protected")):
            with self.assertRaises(ValueError):
                ph.configure(self.root, apply=True)
        self.assertEqual(self.path.read_text(), self.source)

    def test_write_failure_preserves_original_and_private_backup(self):
        with mock.patch.object(ph, "verify_runtime"), mock.patch.object(ph, "atomic_write", side_effect=OSError("disk error")):
            with self.assertRaises(OSError):
                ph.configure(self.root, apply=True)
        self.assertEqual(self.path.read_text(), self.source)
        backups = list(self.root.glob(ph.BACKUP_PREFIX + "*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), self.source)
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)

    def test_late_concurrent_change_is_preserved_after_backup(self):
        original_read = ph.private_read
        calls = 0
        newer = self.source + "\n# updated during backup\n"
        def read(root, name):
            nonlocal calls
            calls += 1
            if calls == 3:
                self.write(newer)
            return original_read(root, name)
        with mock.patch.object(ph, "verify_runtime"), mock.patch.object(ph, "private_read", side_effect=read):
            with self.assertRaisesRegex(ValueError, "変更"):
                ph.configure(self.root, apply=True)
        self.assertEqual(self.path.read_text(), newer)

    def test_restore_never_reads_external_or_arbitrary_backups(self):
        for path in [self.root / "other-backup", self.root.parent / (ph.BACKUP_PREFIX + "outside")]:
            with self.assertRaises(ValueError):
                ph.configure(self.root, apply=True, restore=path)
        self.assertEqual(self.path.read_text(), self.source)

    def test_apply_restore_apply_roundtrip_is_reproducible(self):
        with mock.patch.object(ph, "verify_runtime"):
            first = ph.configure(self.root, apply=True)
            applied = self.path.read_text()
            ph.configure(self.root, apply=True, restore=first["backup"])
            ph.configure(self.root, apply=True)
        self.assertEqual(self.path.read_text(), applied)

    def test_unsafe_permissions_and_hardlinked_configs_are_refused(self):
        target = self.root / "hardlink"
        os.link(self.path, target)
        with self.assertRaises(ValueError):
            ph.configure(self.root)
        target.unlink()
        self.root.chmod(0o777)
        with self.assertRaises(ValueError):
            ph.configure(self.root)
        self.root.chmod(0o700)

    def test_preview_never_discloses_private_headers(self):
        result = subprocess.run([sys.executable, str(Path(ph.__file__))],
                                env={**os.environ, "CODEX_HOME": str(self.root)}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertNotIn("private-test-value", result.stdout + result.stderr)
        self.assertEqual(self.path.read_text(), self.source)


if __name__ == "__main__":
    unittest.main()
