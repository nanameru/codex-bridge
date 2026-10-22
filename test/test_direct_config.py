import json
import os
from pathlib import Path
import sys
import tempfile
import tomllib
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import direct_codex
import direct_launch


class DirectConfigTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.path = self.root / "config.toml"
        self.source = 'model="gpt-6.1-sol"\nopenai_base_url="http://127.0.0.1:8790/v1"\n[profiles.work]\nmodel="other"\n'
        self.path.write_text(self.source)
        (self.root / "model-catalog.json").write_text(json.dumps({"models": [
            {"slug": "deepseek-v4.1-flash", "auto_compact_token_limit": 500000},
            {"slug": "grok-4.7"}, {"slug": "hy4-preview"}]}))

    def test_adds_isolated_official_profile_without_changing_defaults(self):
        self.assertEqual(direct_codex.configure(self.root), 2)
        config = tomllib.loads(self.path.read_text())
        self.assertEqual(config["model"], "gpt-6.1-sol")
        self.assertEqual(config["openai_base_url"], "http://127.0.0.1:8790/v1")
        self.assertEqual(config["profiles"]["work"], {"model": "other"})
        self.assertNotIn(direct_codex.PROVIDER, config["profiles"])
        profile = tomllib.loads((self.root / (direct_codex.PROVIDER + ".config.toml")).read_text())
        self.assertEqual(profile["model_provider"], direct_codex.PROVIDER)
        provider = config["model_providers"][direct_codex.PROVIDER]
        self.assertFalse(provider["requires_openai_auth"])
        self.assertEqual(provider["base_url"], direct_codex.BASE_URL)
        self.assertEqual(provider["env_key"], "OPENCODE_API_KEY")
        catalog = self.root / "opencode-direct-model-catalog.json"
        self.assertEqual(catalog.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.root / "bin/codex-opencode").stat().st_mode & 0o777, 0o700)
        self.assertEqual([model["slug"] for model in json.loads(catalog.read_text())["models"]],
                         ["deepseek-v4.1-flash", "grok-4.7"])
        backup = list(self.root.glob("config.toml.bak.direct.*"))
        self.assertEqual(len(backup), 1)
        self.assertEqual(backup[0].read_text(), self.source)
        direct_codex.configure(self.root)
        self.assertEqual(len(list(self.root.glob("config.toml.bak.direct.*"))), 1)

    def test_does_not_overwrite_a_custom_provider_or_profile(self):
        for table in ["model_providers", "profiles"]:
            self.path.write_text(self.source + f'[{table}.{direct_codex.PROVIDER}]\nname="custom"\n')
            before = self.path.read_bytes()
            with self.assertRaisesRegex(ValueError, "上書き"):
                direct_codex.configure(self.root)
            self.assertEqual(self.path.read_bytes(), before)

    def test_never_reads_login_database(self):
        directory = self.root / ".local/share/opencode"
        directory.mkdir(parents=True)
        (directory / "opencode.db").write_text("do not read")
        self.assertIsNone(direct_codex.api_key({}, self.root))
        (directory / "auth.json").write_text(json.dumps({"opencode-go": {"type": "api", "key": "fake-key"}}))
        self.assertEqual(direct_codex.api_key({}, self.root), "fake-key")
        self.assertEqual(direct_codex.api_key({"OPENCODE_API_KEY": "override"}, self.root), "override")
        (directory / "auth.json").write_text(json.dumps({"opencode-go": {"type": "oauth", "access": "do-not-use"}}))
        self.assertIsNone(direct_codex.api_key({}, self.root))

    def test_preserves_an_existing_external_profile(self):
        profile = self.root / (direct_codex.PROVIDER + ".config.toml")
        profile.write_text('model="custom"\n')
        with self.assertRaisesRegex(ValueError, "上書き"):
            direct_codex.configure(self.root)
        self.assertEqual(profile.read_text(), 'model="custom"\n')
        self.assertEqual(self.path.read_text(), self.source)

    def test_launcher_keeps_api_key_out_of_arguments_and_configuration(self):
        with mock.patch.dict(os.environ, {"OPENCODE_API_KEY": "fake-secret"}), mock.patch.object(
                sys, "argv", ["direct_codex.py", "run", "--model", "grok-4.7"]), mock.patch.object(
                direct_launch.subprocess, "run", return_value=mock.Mock(returncode=0)) as run:
            with self.assertRaises(SystemExit) as result:
                direct_codex.main()
        self.assertEqual(result.exception.code, 0)
        self.assertNotIn("fake-secret", " ".join(run.call_args.args[0]))
        self.assertEqual(run.call_args.kwargs["env"]["OPENCODE_API_KEY"], "fake-secret")
