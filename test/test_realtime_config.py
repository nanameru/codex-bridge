"""Issue #145: Realtime voice URL matrix for unified on/off/repair and doctor."""
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import tomllib
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import realtime_config
import switch_config
import unified_config

KEY = realtime_config.KEY
BASE = 'model="gpt-test"\n# preserve\n'
TAIL = ('[profiles.work]\nmodel="profile"\n[model_providers.codex-bridge]\nname="Existing"\n'
        'base_url="http://127.0.0.1:8788/v1"\nwire_api="responses"\n')


class RealtimeMatrixTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.path = self.root / "config.toml"
        self.state_path = self.root / "unified-router-state.json"
        catalog = {"models": [{"slug": "gpt-test"}, {"slug": "opencode/deepseek-test"}]}
        (self.root / "unified-model-catalog.json").write_text(json.dumps(catalog))
        self.health = lambda *_a, **_k: io.StringIO(json.dumps({"mode": "unified", "model_ids": [m["slug"] for m in catalog["models"]]}))
        self.environment = mock.patch.dict(realtime_config.os.environ, {}, clear=False)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        realtime_config.os.environ.pop(realtime_config.KEEP_ENV, None)

    def write(self, realtime_line=""):
        self.path.write_text(BASE + realtime_line + TAIL)
        return tomllib.loads(self.path.read_text())

    def on(self):
        with mock.patch.object(unified_config, "urlopen", side_effect=self.health), contextlib.redirect_stdout(io.StringIO()) as out:
            unified_config.configure(self.root, "on", 8790)
        return out.getvalue()

    def off(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            unified_config.configure(self.root, "off", 8790)
        return out.getvalue()

    def repair(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            switch_config.switch("repair", self.root)
        return out.getvalue()

    def config(self):
        return tomllib.loads(self.path.read_text())

    def doctor(self, probe=False):
        return realtime_config.diagnose(self.root, probe)

    def test_unset_is_pinned_to_official_and_removed_again_on_off(self):
        original = self.write()
        self.assertFalse(self.doctor()["ok"] is False and False)
        self.on()
        self.assertEqual(self.config()[KEY], realtime_config.OFFICIAL_URL)
        self.assertEqual(self.config()["openai_base_url"], "http://127.0.0.1:8790/v1")
        state = json.loads(self.state_path.read_text())["realtime"]
        self.assertEqual(state, {"original": {"present": False, "value": None}, "owner": "bridge",
                                 "bridge_value": realtime_config.OFFICIAL_URL})
        report = self.doctor()
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["realtime_target"], "wss://api.openai.com/v1/realtime")
        self.assertEqual(report["text_base_url"], "http://127.0.0.1:8790/v1")
        self.off()
        self.assertEqual(self.config(), original)
        self.assertNotIn(KEY, self.path.read_text())
        self.assertIn("# preserve", self.path.read_text())
        self.assertIn("無効", self.off())

    def test_bridge_managed_value_is_idempotent_across_on_and_repair(self):
        self.write()
        self.on()
        first = self.config()
        state = self.state_path.read_text()
        self.on()
        self.assertEqual(self.config(), first)
        self.repair()
        settled = self.path.read_text()
        self.assertEqual(self.config(), first)
        for step in [self.on, self.repair, self.repair]:
            step()
        self.assertEqual(self.path.read_text(), settled)
        self.assertEqual(self.state_path.read_text(), state)

    def test_empty_string_stops_without_changes(self):
        self.write(KEY + ' = ""\n')
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, "空または不正"):
            self.on()
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(self.state_path.exists())
        self.assertEqual(self.doctor()["realtime_setting"]["state"], "empty")
        self.assertFalse(self.doctor()["ok"])

    def test_official_value_is_user_owned_and_kept_after_off(self):
        for value in ["wss://api.openai.com/v1", "https://api.openai.com/v1/realtime"]:
            with self.subTest(value=value):
                original = self.write(f'{KEY} = "{value}"\n')
                self.on()
                self.assertEqual(self.config()[KEY], value)
                self.assertEqual(json.loads(self.state_path.read_text())["realtime"]["owner"], "user")
                self.assertTrue(self.doctor()["ok"])
                self.off()
                self.assertEqual(self.config(), original)

    def test_third_party_loopback_proxy_is_never_overwritten(self):
        for value in ["http://127.0.0.1:10100/v1", "ws://localhost:10100/v1", "http://[::1]:10100/v1"]:
            with self.subTest(value=value):
                self.write(f'{KEY} = "{value}"\n')
                before = self.path.read_bytes()
                with self.assertRaises(ValueError) as caught:
                    self.on()
                self.assertIn("上書きしません", str(caught.exception))
                self.assertIn("realtime_config.py doctor", str(caught.exception))
                self.assertEqual(self.path.read_bytes(), before)
                self.assertFalse(self.state_path.exists())
                report = self.doctor()
                self.assertEqual(report["realtime_setting"]["state"], "loopback-foreign")
                self.assertFalse(report["ok"])

    def test_explicit_keep_preserves_foreign_proxy_through_on_off(self):
        original = self.write(f'{KEY} = "http://127.0.0.1:10100/v1"\n')
        realtime_config.os.environ[realtime_config.KEEP_ENV] = "1"
        self.assertIn("保持します", self.on())
        self.assertEqual(self.config()[KEY], "http://127.0.0.1:10100/v1")
        self.repair()
        self.assertEqual(self.config()[KEY], "http://127.0.0.1:10100/v1")
        self.off()
        self.assertEqual(self.config(), original)

    def test_text_router_url_in_realtime_is_refused(self):
        self.write(f'{KEY} = "http://127.0.0.1:8790/v1"\n')
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, "Realtimeを実装していない"):
            self.on()
        self.assertEqual(self.path.read_bytes(), before)

    def test_remote_custom_value_is_kept_with_warning(self):
        original = self.write(f'{KEY} = "wss://realtime.example.com/v1"\n')
        self.assertIn("本人設定として保持", self.on())
        self.assertEqual(self.config()[KEY], "wss://realtime.example.com/v1")
        self.off()
        self.assertEqual(self.config(), original)

    def test_value_changed_after_on_is_kept_by_off(self):
        self.write()
        self.on()
        self.path.write_text(unified_config.edit_table(self.path.read_text(), (), {KEY: "wss://realtime.example.com/v1"}))
        self.assertIn("変更されたため保持", self.off())
        self.assertEqual(self.config()[KEY], "wss://realtime.example.com/v1")
        self.assertFalse(self.state_path.exists())

    def test_interrupted_on_and_off_recover_idempotently(self):
        original = self.write()
        # on: state saved but config.toml was not replaced yet.
        self.state_path.write_text(json.dumps({
            "root": {"openai_base_url": None, "model_catalog_json": None},
            "bridge": {"base_url": "http://127.0.0.1:8788/v1", "requires_openai_auth": None, "wire_api": "responses"},
            "bridge_existed": True,
            "realtime": {"original": {"present": False, "value": None}, "owner": "bridge",
                         "bridge_value": realtime_config.OFFICIAL_URL}}))
        self.on()
        self.assertEqual(self.config()[KEY], realtime_config.OFFICIAL_URL)
        self.assertEqual(json.loads(self.state_path.read_text())["realtime"]["original"],
                         {"present": False, "value": None})
        # off: config.toml restored but the state file was left behind.
        saved = self.state_path.read_text()
        self.off()
        self.assertEqual(self.config(), original)
        self.state_path.write_text(saved)
        self.off()
        self.assertEqual(self.config(), original)
        self.assertFalse(self.state_path.exists())

    def test_legacy_state_without_realtime_is_migrated_by_repair(self):
        self.write()
        self.on()
        state = json.loads(self.state_path.read_text())
        state.pop("realtime")
        self.state_path.write_text(json.dumps(state))
        self.path.write_text(unified_config.edit_table(self.path.read_text(), (), {KEY: None}))
        self.assertFalse(self.doctor()["ok"])
        self.repair()
        self.assertEqual(self.config()[KEY], realtime_config.OFFICIAL_URL)
        self.assertEqual(json.loads(self.state_path.read_text())["realtime"]["owner"], "bridge")
        self.assertTrue(self.doctor()["ok"])

    def test_repair_refuses_foreign_proxy_without_touching_files(self):
        self.write()
        self.on()
        self.path.write_text(unified_config.edit_table(self.path.read_text(), (), {KEY: "http://127.0.0.1:10100/v1"}))
        before = (self.path.read_bytes(), self.state_path.read_bytes())
        with self.assertRaisesRegex(ValueError, "上書きしません"):
            self.repair()
        self.assertEqual((self.path.read_bytes(), self.state_path.read_bytes()), before)


class RealtimeDoctorTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def diagnose(self, text, probe=False):
        (self.root / "config.toml").write_text(text)
        return realtime_config.diagnose(self.root, probe)

    def test_defaults_and_text_override_are_distinguished(self):
        report = self.diagnose('model="gpt"\n')
        self.assertTrue(report["ok"])
        self.assertEqual(report["realtime_target"], "wss://api.openai.com/v1/realtime")
        report = self.diagnose('openai_base_url="http://127.0.0.1:10100/v1"\n')
        self.assertFalse(report["ok"])
        self.assertEqual(report["realtime_target"], "ws://127.0.0.1:10100/v1/realtime")
        self.assertIn("テキスト用", report["problems"][0])
        report = self.diagnose('model_provider="codex-bridge"\n[model_providers.codex-bridge]\n'
                               'base_url="http://127.0.0.1:8790/v1"\n')
        self.assertEqual(report["realtime_target"], "ws://127.0.0.1:8790/v1/realtime")
        self.assertFalse(report["ok"])
        report = self.diagnose(f'openai_base_url="http://127.0.0.1:8790/v1"\n{KEY}="wss://api.openai.com/v1"\n')
        self.assertTrue(report["ok"])
        self.assertEqual(report["text_base_url"], "http://127.0.0.1:8790/v1")

    def test_doctor_cli_survives_a_non_utf8_console(self):
        import os, subprocess
        (self.root / "config.toml").write_text('openai_base_url="http://127.0.0.1:10100/v1"\n')
        script = Path(__file__).resolve().parents[1] / "scripts" / "realtime_config.py"
        env = {**os.environ, "CODEX_HOME": str(self.root), "PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0"}
        result = subprocess.run([sys.executable, str(script), "doctor"], env=env,
                                capture_output=True)
        self.assertEqual(result.returncode, 1, result.stderr.decode("utf-8", "replace"))
        report = json.loads(result.stdout.decode("utf-8"))
        self.assertEqual(report["realtime_target"], "ws://127.0.0.1:10100/v1/realtime")

    def test_output_never_contains_credentials_or_query(self):
        report = self.diagnose(f'{KEY}="wss://user:secret@realtime.example.com/v1?token=abc"\n')
        text = json.dumps(report)
        self.assertNotIn("secret", text)
        self.assertNotIn("token=abc", text)

    def test_probe_detects_a_router_that_rejects_websocket_upgrades(self):
        class Rejecting(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(426)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Rejecting)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        port = server.server_address[1]
        report = self.diagnose(f'openai_base_url="http://127.0.0.1:{port}/v1"\n', probe=True)
        self.assertEqual(report["probe_status"], 426)
        self.assertTrue(any("HTTP 426" in problem for problem in report["problems"]))
        report = self.diagnose(f'{KEY}="wss://api.openai.com/v1"\n', probe=True)
        self.assertIsNone(report["probe_status"])

    def test_websocket_target_matches_codex_derivation(self):
        cases = {"http://127.0.0.1:8011": "ws://127.0.0.1:8011/v1/realtime",
                 "wss://api.openai.com/v1": "wss://api.openai.com/v1/realtime",
                 "https://api.openai.com/v1/realtime": "wss://api.openai.com/v1/realtime"}
        for base, expected in cases.items():
            self.assertEqual(realtime_config.websocket_target(base), expected)


if __name__ == "__main__":
    unittest.main()
