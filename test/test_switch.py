import os
from pathlib import Path
import subprocess
import tempfile
import tomllib
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "switch.sh"


class SwitchTests(unittest.TestCase):
    script = SCRIPT

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.config = self.root / "config.toml"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.calls = self.root / "calls"
        for command in ["codex", "osascript", "open", "sleep"]:
            stub = self.bin / command
            stub.write_text('#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$SWITCH_TEST_CALLS"\n')
            stub.chmod(0o755)
        self.environment = {
            **os.environ,
            "CODEX_HOME": str(self.root),
            "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
            "SWITCH_TEST_CALLS": str(self.calls),
        }

    def switch(self, mode, success=True):
        result = subprocess.run(
            ["bash", str(self.script), mode], env=self.environment,
            capture_output=True, text=True,
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def read(self):
        return tomllib.loads(self.config.read_text())

    def test_round_trip_preserves_provider_and_profiles(self):
        self.config.write_text('model = "normal"\nmodel_provider = "custom"\nmodel_catalog_json = "original.json"\n# keep\n[profiles.work]\nmodel = "profile-model"\n[model_providers.custom]\nname = "Custom"\nbase_url = "http://localhost/v1"\n')
        original = self.read()
        self.switch("on")
        self.assertEqual(self.read()["model_provider"], "codex-bridge")
        self.assertEqual(self.read()["model"], "deepseek-v4.1-flash")
        self.switch("on")
        self.switch("off")
        restored = self.read()
        self.assertIn("codex-bridge", restored["model_providers"])
        del restored["model_providers"]["codex-bridge"]
        self.assertEqual(restored, original)
        self.assertIn("# keep", self.config.read_text())
        self.switch("off")
        self.assertFalse(self.calls.exists(), "切替が外部アプリを操作した")

    def test_repair_changes_only_missing_provider(self):
        self.config.write_text('model = "normal"\n[profiles.work]\nmodel = "profile"\n')
        original = self.read()
        self.switch("repair")
        repaired = self.read()
        self.assertEqual(repaired["model"], original["model"])
        self.assertEqual(repaired["profiles"], original["profiles"])
        self.assertEqual(repaired["model_providers"]["codex-bridge"]["wire_api"], "responses")
        first = self.config.read_text()
        self.switch("repair")
        self.assertEqual(self.config.read_text(), first)
        self.assertFalse(self.calls.exists())

    def test_existing_provider_and_multiline_text_preserved(self):
        text = 'instructions = """\nmodel = "inside-text"\n[model_providers.fake]\n"""\n[model_providers."codex-bridge"]\nname = "Existing"\nbase_url = "http://localhost:9000/v1"\nwire_api = "responses"\n'
        self.config.write_text(text)
        self.switch("on")
        self.assertEqual(self.read()["model_providers"]["codex-bridge"]["name"], "Existing")
        self.switch("off")
        self.assertNotIn("model", self.read())
        self.assertEqual(self.read()["instructions"], tomllib.loads(text)["instructions"])

    def test_invalid_input_never_changes_config_or_backup(self):
        self.config.write_text('model = "normal"\n')
        before = self.config.read_bytes()
        self.switch("invalid", success=False)
        self.assertEqual(self.config.read_bytes(), before)
        self.assertFalse(list(self.root.glob("config.toml.bak.switch*")))
        self.config.write_text('model = "a"\nmodel = "b"\n')
        before = self.config.read_bytes()
        self.switch("on", success=False)
        self.assertEqual(self.config.read_bytes(), before)

    def test_legacy_off_uses_normal_backup_and_keeps_provider(self):
        self.config.write_text('model = "deepseek-v4.1-flash"\nmodel_provider = "codex-bridge"\nmodel_catalog_json = "bridge.json"\n')
        backup = self.root / "config.toml.bak.switch"
        backup.write_text('model = "normal"\n')
        original = backup.read_bytes()
        self.switch("off")
        self.assertEqual(self.read()["model"], "normal")
        self.assertNotIn("model_provider", self.read())
        self.assertIn("codex-bridge", self.read()["model_providers"])
        self.assertEqual(backup.read_bytes(), original)

    def test_legacy_off_without_baseline_uses_codex_defaults(self):
        self.config.write_text('model = "deepseek-v4.1-flash"\nmodel_provider = "codex-bridge"\n')
        self.switch("off")
        self.assertNotIn("model", self.read())
        self.assertNotIn("model_provider", self.read())
        self.assertIn("codex-bridge", self.read()["model_providers"])

    def test_off_preserves_a_new_normal_model_selection(self):
        self.config.write_text('model = "original"\n')
        self.switch("on")
        self.config.write_text(self.config.read_text().replace('model = "deepseek-v4.1-flash"', 'model = "new-normal"').replace('model_provider = "codex-bridge"\n', ''))
        self.switch("off")
        self.assertEqual(self.read()["model"], "new-normal")
        self.assertNotIn("model_provider", self.read())

    def test_invalid_port_keeps_original_and_creates_no_backup(self):
        self.config.write_text('model = "normal"\n')
        before = self.config.read_bytes()
        self.environment["PORT"] = "70000"
        self.switch("repair", success=False)
        self.assertEqual(self.config.read_bytes(), before)
        self.assertFalse(list(self.root.glob("config.toml.bak.switch*")))


if __name__ == "__main__":
    unittest.main()
