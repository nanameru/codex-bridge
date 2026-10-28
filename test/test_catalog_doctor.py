from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
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



def OK(port, root):
    return None


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
        self.assertEqual(doctor.migrate(self.root, 8790, ready=OK), "applied")
        applied = (self.root / "config.toml").read_bytes()
        self.assertNotIn(b"model_catalog_json", applied)
        self.assertIn(b'model_provider = "codex-live"', applied)
        self.assertNotIn(b"\r\r\n", applied)
        self.assertEqual(applied.count(b"\n"), applied.count(b"\r\n"))
        self.assertIn(SECRET.encode(), applied)
        backups = list(self.root.glob("config.toml.issue143-*.bak"))
        self.assertEqual([b.read_bytes() for b in backups], [self.source])
        self.assertEqual(doctor.diagnose(self.root)["status"], "dynamic")
        self.assertEqual(doctor.migrate(self.root, 8790, ready=OK), "unchanged")
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
                    doctor.migrate(self.root, 8790, ready=lambda port, root: "router" if name == "router" else None)
                self.assertEqual(config.read_bytes(), before)
                self.assertFalse((self.root / doctor.STATE).exists())
                self.assertEqual(list(self.root.glob("config.toml.issue143-*.bak")), [])
                (self.root / "live-catalog-state.json").unlink(missing_ok=True)
                config.write_bytes(self.source)
                (self.root / "model-catalog.json").write_text(catalog("opencode/a"))

    def test_refuses_restore_after_user_edit_and_conflicting_reapply(self):
        doctor.migrate(self.root, 8790, ready=OK)
        edited = (self.root / "config.toml").read_bytes() + b"# user edit\r\n"
        (self.root / "config.toml").write_bytes(edited)
        with self.assertRaises(ValueError):
            doctor.restore(self.root)
        with self.assertRaises(ValueError):
            doctor.migrate(self.root, 8790, ready=OK)
        self.assertEqual((self.root / "config.toml").read_bytes(), edited)

    @unittest.skipIf(os.name == "nt", "symlink作成に管理者権限が必要")
    def test_refuses_symlinked_config(self):
        real = self.root / "real.toml"
        (self.root / "config.toml").rename(real)
        (self.root / "config.toml").symlink_to(real)
        with self.assertRaises(ValueError):
            doctor.migrate(self.root, 8790, ready=OK)

    def test_cli_output_never_contains_secrets(self):
        env = {**os.environ, "CODEX_HOME": str(self.root), "PYTHONUTF8": "1"}
        for args in [[], ["--json"]]:
            result = subprocess.run([sys.executable, str(ROOT / "scripts/catalog_doctor.py"), "diagnose", *args],
                                    env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", check=True)
            self.assertNotIn(SECRET, result.stdout + result.stderr)
            self.assertIn("legacy_opencode_only", result.stdout)
        result = subprocess.run([sys.executable, str(ROOT / "scripts/catalog_doctor.py"), "apply", "--port", "9"],
                                env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        self.assertEqual((self.root / "config.toml").read_bytes(), self.source)

    def test_unprefixed_opencode_catalog_is_legacy_when_official_list_disagrees(self):
        names = ["deepseek-v4.1-flash", "gpt-6-luna", "kimi-k3.1-pro"]
        (self.root / "model-catalog.json").write_text(catalog(*names))
        report = doctor.diagnose(self.root)
        self.assertEqual((report["status"], report["native_count"], report["external_count"], report["target_status"]),
                         ("legacy_opencode_only", 0, 3, "hidden_by_catalog"))
        self.assertEqual(doctor.migrate(self.root, 8790, ready=OK), "applied")
        self.assertEqual(doctor.migrate(self.root, 8790, ready=OK), "unchanged")
        (self.root / "model-catalog.json").write_text(catalog("gpt-6.1-sol", *names))
        self.assertEqual(doctor.diagnose(self.root)["status"], "dynamic")
        self.assertEqual(doctor.restore(self.root), "restored")
        report = doctor.diagnose(self.root)
        self.assertEqual((report["status"], report["native_count"], report["target_status"]), ("unified", 1, "listed"))
        (self.root / "models_cache.json").unlink()
        self.assertEqual(doctor.diagnose(self.root)["status"], "native_only")
        with self.assertRaises(ValueError):
            doctor.migrate(self.root, 8790, ready=OK)

    def serve_health(self, health):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = json.dumps(health).encode()
                self.send_response(200 if self.path == "/health" else 404)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_address[1]

    def test_apply_refuses_router_that_cannot_authenticate_this_codex_home(self):
        same = doctor.home_id(self.root)
        refused = {
            "old_router": {"live_catalog": True},
            "other_home": {"live_catalog": True, "catalog_auth": {"codex_home": "0" * 64, "ready": True}},
            "auth_missing": {"live_catalog": True, "catalog_auth": {"codex_home": same, "ready": False}},
            "static_router": {"live_catalog": False, "catalog_auth": {"codex_home": same, "ready": True}},
        }
        for name, health in refused.items():
            with self.subTest(name):
                port = self.serve_health(health)
                with self.assertRaises(ValueError):
                    doctor.migrate(self.root, port)
                self.assertEqual((self.root / "config.toml").read_bytes(), self.source)
                self.assertFalse((self.root / doctor.STATE).exists())
                self.assertEqual(list(self.root.glob("config.toml.issue143-*.bak")), [])
        port = self.serve_health({"live_catalog": True, "catalog_auth": {"codex_home": same, "ready": True}})
        self.assertEqual(doctor.migrate(self.root, port), "applied")
        self.assertIn(f"127.0.0.1:{port}/codex/models".encode(), (self.root / "config.toml").read_bytes())

    @unittest.skipIf(shutil.which("node") is None, "nodeが必要")
    def test_home_id_matches_router(self):
        script = ("import('./src/local-security.mjs').then(m => "
                  "process.stdout.write(m.codexHomeId(process.argv[1])))")
        result = subprocess.run(["node", "-e", script, str(self.root)], cwd=ROOT, capture_output=True,
                                text=True, encoding="utf-8", errors="replace", check=True)
        self.assertEqual(result.stdout, doctor.home_id(self.root))

    def test_diagnose_writes_nothing(self):
        before = sorted(p.name for p in self.root.iterdir())
        env = {**os.environ, "CODEX_HOME": str(self.root), "PYTHONUTF8": "1"}
        subprocess.run([sys.executable, str(ROOT / "scripts/catalog_doctor.py"), "diagnose"], env=env,
                       capture_output=True, check=True)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), before)


if __name__ == "__main__":
    unittest.main()
