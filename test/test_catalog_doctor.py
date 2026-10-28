import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import catalog_doctor as doctor

SECRET = "sk-issue143-must-not-leak"
WINDOWS_CONFIG = ('openai_base_url = "http://127.0.0.1:10100/v1"\r\n'
                  'model = "opencode/deepseek-v4.1-flash"\r\n'
                  'model_provider = "codex-bridge-local"\r\n'
                  'model_catalog_json = "{catalog}"\r\n'
                  '[model_providers.codex-bridge-local]\r\nname = "Bridge"\r\n'
                  f'experimental_bearer_token = "{SECRET}"\r\n')


def catalog(*names):
    return json.dumps({"models": [{"slug": n, "display_name": n} for n in names]})


class CatalogDoctorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        legacy = [f"opencode/model-{i}" for i in range(38)] + ["opencode/gpt-5.6-luna", "opencode/gpt-6-luna"]
        (self.root / "model-catalog.json").write_text(catalog(*legacy))
        (self.root / "models_cache.json").write_text(catalog("gpt-6.1-sol", "gpt-6.1-astra", "opencode/stale"))
        (self.root / "auth.json").write_text(json.dumps({"tokens": SECRET}))
        self.source = WINDOWS_CONFIG.format(catalog=(self.root / "model-catalog.json").as_posix()).encode()
        (self.root / "config.toml").write_bytes(self.source)

    def tearDown(self):
        self.temp.cleanup()

    def test_detects_legacy_catalog_hiding_official_model(self):
        report = doctor.diagnose(self.root)
        self.assertEqual((report["status"], report["native_count"], report["external_count"]),
                         ("legacy_opencode_only", 0, 40))
        self.assertEqual(report["target_status"], "hidden_by_catalog")

    def test_distinguishes_plan_side_absence_from_catalog_omission(self):
        (self.root / "models_cache.json").write_text(catalog("gpt-6.1-astra"))
        self.assertEqual(doctor.diagnose(self.root)["target_status"], "not_in_official_list")
        (self.root / "models_cache.json").unlink()
        self.assertEqual(doctor.diagnose(self.root)["target_status"], "unknown_no_cache")

    def test_unified_catalog_lists_both_but_does_not_claim_plan_access(self):
        (self.root / "model-catalog.json").write_text(catalog("gpt-6.1-sol", "opencode/deepseek-v4.1-flash"))
        report = doctor.diagnose(self.root)
        self.assertEqual((report["status"], report["target_status"]), ("unified", "listed"))
        self.assertIn("実際の1回の送信", report["target_message"])

    def test_apply_backs_up_preserves_crlf_and_is_idempotent(self):
        self.assertEqual(doctor.migrate(self.root, 8790, ready=lambda port: True), "applied")
        applied = (self.root / "config.toml").read_bytes()
        self.assertNotIn(b"model_catalog_json", applied)
        self.assertIn(b'model_provider = "codex-live"', applied)
        self.assertNotIn(b"\r\r\n", applied)
        self.assertEqual(applied.count(b"\n"), applied.count(b"\r\n"))
        self.assertIn(SECRET.encode(), applied)
        backups = list(self.root.glob("config.toml.issue143-*.bak"))
        self.assertEqual([b.read_bytes() for b in backups], [self.source])
        self.assertEqual(doctor.diagnose(self.root)["status"], "dynamic")
        self.assertEqual(doctor.migrate(self.root, 8790, ready=lambda port: True), "unchanged")
        self.assertEqual((self.root / "config.toml").read_bytes(), applied)
        self.assertEqual(doctor.restore(self.root), "restored")
        self.assertEqual((self.root / "config.toml").read_bytes(), self.source)
        self.assertTrue(backups[0].exists())

    def test_fails_closed_without_writing(self):
        config = self.root / "config.toml"
        setups = {
            "router": lambda: None,
            "foreign_state": lambda: (self.root / "live-catalog-state.json").write_text("{}"),
            "unknown": lambda: (self.root / "model-catalog.json").write_text("not json"),
            "custom_live": lambda: config.write_bytes(self.source + b'[model_providers.codex-live]\r\nname = "Mine"\r\n'),
            "bom": lambda: config.write_bytes(b"\xef\xbb\xbf" + self.source),
        }
        for name, setup in setups.items():
            with self.subTest(name):
                setup()
                before = config.read_bytes()
                with self.assertRaises(ValueError):
                    doctor.migrate(self.root, 8790, ready=lambda port: name != "router")
                self.assertEqual(config.read_bytes(), before)
                self.assertFalse((self.root / doctor.STATE).exists())
                self.assertEqual(list(self.root.glob("config.toml.issue143-*.bak")), [])
                (self.root / "live-catalog-state.json").unlink(missing_ok=True)
                config.write_bytes(self.source)
                (self.root / "model-catalog.json").write_text(catalog("opencode/a"))

    def test_refuses_restore_after_user_edit_and_conflicting_reapply(self):
        doctor.migrate(self.root, 8790, ready=lambda port: True)
        edited = (self.root / "config.toml").read_bytes() + b"# user edit\r\n"
        (self.root / "config.toml").write_bytes(edited)
        with self.assertRaises(ValueError):
            doctor.restore(self.root)
        with self.assertRaises(ValueError):
            doctor.migrate(self.root, 8790, ready=lambda port: True)
        self.assertEqual((self.root / "config.toml").read_bytes(), edited)

    @unittest.skipIf(os.name == "nt", "symlink作成に管理者権限が必要")
    def test_refuses_symlinked_config(self):
        real = self.root / "real.toml"
        (self.root / "config.toml").rename(real)
        (self.root / "config.toml").symlink_to(real)
        with self.assertRaises(ValueError):
            doctor.migrate(self.root, 8790, ready=lambda port: True)

    def test_cli_output_never_contains_secrets(self):
        env = {**os.environ, "CODEX_HOME": str(self.root), "PYTHONUTF8": "1"}
        for args in [[], ["--json"]]:
            result = subprocess.run([sys.executable, str(ROOT / "scripts/catalog_doctor.py"), "diagnose", *args],
                                    env=env, capture_output=True, encoding="utf-8", check=True)
            self.assertNotIn(SECRET, result.stdout + result.stderr)
            self.assertIn("legacy_opencode_only", result.stdout)
        result = subprocess.run([sys.executable, str(ROOT / "scripts/catalog_doctor.py"), "apply", "--port", "9"],
                                env=env, capture_output=True, encoding="utf-8")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        self.assertEqual((self.root / "config.toml").read_bytes(), self.source)


if __name__ == "__main__":
    unittest.main()
