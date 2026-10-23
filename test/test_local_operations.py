import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import plistlib
import stat
import sys
import tempfile
import unittest
from unittest import mock
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import local_security
import install_router_service
import patch_legacy_security
import secure_local


class LocalOperationsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_internal_key_is_private_exclusive_and_stable(self):
        local_security.ensure_bridge_key(self.root)
        path = self.root / "bridge-local-token"
        first = path.read_bytes()
        local_security.ensure_bridge_key(self.root)
        self.assertEqual(path.read_bytes(), first)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            local_security.ensure_bridge_key(self.root)
        self.assertEqual(path.read_bytes(), first)
        path.unlink()
        target = self.root / "unrelated"
        target.write_text("PRESERVE")
        path.symlink_to(target)
        with self.assertRaises(OSError):
            local_security.ensure_bridge_key(self.root)
        self.assertEqual(target.read_text(), "PRESERVE")

    def test_wrong_key_content_and_shared_parent_never_get_overwritten(self):
        path = self.root / "bridge-local-token"
        path.write_text("unrecognized credential")
        path.chmod(0o600)
        with self.assertRaises(ValueError):
            local_security.ensure_bridge_key(self.root)
        self.assertEqual(path.read_text(), "unrecognized credential")
        path.unlink()
        self.root.chmod(0o777)
        try:
            with self.assertRaises(ValueError):
                local_security.ensure_bridge_key(self.root)
            self.assertFalse(path.exists())
        finally:
            self.root.chmod(0o700)

    def test_health_never_probes_inference_on_an_unprotected_or_wrong_revision_service(self):
        for health in [{"ok": True}, {"security": local_security.SECURITY_VERSION, "request_dump": True},
                       {"security": local_security.SECURITY_VERSION, "implementation": "old"}]:
            with mock.patch.object(local_security, "get_health", return_value=health), \
                    mock.patch.object(local_security, "build_opener") as opener:
                with self.assertRaises(ValueError):
                    local_security.verify_service(8790, "expected")
                opener.assert_not_called()

    def test_rejection_probe_uses_only_an_invalid_credential_and_no_user_input(self):
        health = {"security": local_security.SECURITY_VERSION, "implementation": "expected"}
        opener = mock.Mock()
        opener.open.side_effect = HTTPError("http://127.0.0.1", 401, "Unauthorized", {}, None)
        with mock.patch.object(local_security, "get_health", return_value=health), \
                mock.patch.object(local_security, "build_opener", return_value=opener):
            self.assertEqual(local_security.verify_service(8790, "expected"), health)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.data, b"{}")
        self.assertEqual(request.get_header("Authorization"), "Bearer invalid-local-probe")

    def test_failed_runtime_verification_restores_definition_and_running_service(self):
        path = self.root / "router.plist"
        previous = plistlib.dumps({"Label": "test-router", "ProgramArguments": ["old"]})
        path.write_bytes(previous)
        payload = {"Label": "test-router", "ProgramArguments": ["new"]}
        with mock.patch.object(install_router_service.subprocess, "run") as run, \
                mock.patch.object(install_router_service, "wait_for_unload"):
            with self.assertRaisesRegex(ValueError, "unhealthy"):
                install_router_service.replace_registration(path, payload, "gui/test/test-router", previous,
                                                           True, lambda: (_ for _ in ()).throw(ValueError("unhealthy")))
        self.assertEqual(path.read_bytes(), previous)
        commands = [call.args[0][1] for call in run.call_args_list]
        self.assertEqual(commands, ["bootout", "bootstrap", "bootout", "bootstrap"])

    def test_first_install_failure_removes_only_the_new_registration(self):
        path = self.root / "new.plist"
        with mock.patch.object(install_router_service.subprocess, "run"), \
                mock.patch.object(install_router_service, "wait_for_unload"):
            with self.assertRaises(ValueError):
                install_router_service.replace_registration(path, {"Label": "test"}, "gui/test/test", None,
                                                           False, lambda: (_ for _ in ()).throw(ValueError()))
        self.assertFalse(path.exists())

    def test_security_patch_is_idempotent_and_preserves_unknown_functionality(self):
        source = "\n".join(old for old, _new in patch_legacy_security.REPLACEMENTS)
        # The legacy block has a blank separator before the following const statement.
        auth = (Path(__file__).parent / "fixtures/legacy-auth-v1.txt").read_text() + "\n"
        source += "\n" + auth + "const log = () => {};"
        source += "\n// PRESERVE_REASONING_AND_TIMEOUTS"
        result = patch_legacy_security.patched_source(source)
        self.assertIn("PRESERVE_REASONING_AND_TIMEOUTS", result)
        self.assertEqual(patch_legacy_security.patched_source(result), result)
        with_chat_import = result.replace('import http from "node:http";',
            'import { chatMessages } from "./chat-protocol.mjs";\nimport http from "node:http";')
        self.assertEqual(patch_legacy_security.patched_source(with_chat_import), with_chat_import)
        with self.assertRaises(ValueError):
            patch_legacy_security.patched_source(with_chat_import.replace(patch_legacy_security.IMPORT, ''))
        self.assertNotIn("readOAuthToken", result)
        self.assertNotIn("sqlite3", result)
        for old, _new in patch_legacy_security.REPLACEMENTS:
            with self.assertRaises(ValueError):
                patch_legacy_security.patched_source(source.replace(old, "unknown", 1))
        with self.assertRaises(ValueError):
            patch_legacy_security.patched_source(source.replace("120_000", "60_000"))

    def test_managed_security_helper_can_upgrade_but_unknown_edits_are_preserved(self):
        target = self.root / "bridge.mjs"
        target.write_text("export {};\n")
        module = self.root / "local-security.mjs"
        module.write_text("// previous managed helper\n")
        manifest = self.root / ".local-security.sha256"
        manifest.write_text(hashlib.sha256(module.read_bytes()).hexdigest())
        original = module.read_bytes()
        with mock.patch.object(patch_legacy_security, "patched_source", side_effect=lambda value: value):
            patch_legacy_security.apply(target)
            patch_legacy_security.apply(target)
        self.assertNotEqual(module.read_bytes(), original)
        self.assertEqual(len(list(self.root.glob("local-security.mjs.bak.security.*"))), 1)
        self.assertEqual(manifest.read_text().strip(), hashlib.sha256(module.read_bytes()).hexdigest())
        module.write_text("// manual edit\n")
        with self.assertRaises(ValueError):
            patch_legacy_security.prepare(target)
        self.assertEqual(module.read_text(), "// manual edit\n")

    def test_doctor_is_read_only_and_never_displays_secret_or_exception_content(self):
        capture = io.StringIO()
        with contextlib.redirect_stdout(capture), \
                mock.patch.object(secure_local, "check_credentials", side_effect=ValueError("SECRET")), \
                mock.patch.object(secure_local, "check_opencode_credentials", side_effect=ValueError("SECRET")), \
                mock.patch.object(secure_local, "ensure_existing_key", side_effect=ValueError("SECRET")), \
                mock.patch.object(secure_local, "verify_service", side_effect=ValueError("SECRET")), \
                mock.patch.object(secure_local, "check_config", side_effect=ValueError("SECRET")):
            self.assertFalse(secure_local.doctor(self.root))
        output = capture.getvalue()
        self.assertNotIn("SECRET", output)
        self.assertFalse(json.loads(output)["ok"])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_waits_for_both_services_and_does_not_restart_busy_processes(self):
        with mock.patch.object(install_router_service.subprocess, "run", return_value=mock.Mock(returncode=0)) as run:
            with self.assertRaises(SystemExit):
                install_router_service.wait_for_idle(0, ports=(8790, 8788))
        self.assertEqual(len(run.call_args_list), 2)
        self.assertTrue(all(call.args[0][0] == "lsof" for call in run.call_args_list))

    def test_legacy_update_does_not_wait_for_or_restart_an_unrelated_native_stream(self):
        target = self.root / "codex-bridge.mjs"
        target.write_text("source")
        module = self.root / "local-security.mjs"
        agents = self.root / "Library/LaunchAgents"
        agents.mkdir(parents=True)
        (agents / (secure_local.LEGACY_LABEL + ".plist")).write_bytes(plistlib.dumps({
            "Label": secure_local.LEGACY_LABEL, "ProgramArguments": ["node", str(target)],
        }))
        with mock.patch.object(secure_local.sys, "platform", "darwin"), \
                mock.patch.object(secure_local.Path, "home", return_value=self.root), \
                mock.patch.object(secure_local, "check_credentials"), \
                mock.patch.object(secure_local, "check_opencode_credentials"), \
                mock.patch.object(secure_local, "check_config"), \
                mock.patch.object(secure_local, "ensure_bridge_key"), \
                mock.patch.object(secure_local.patch_legacy_security, "prepare", return_value=("source", "updated", module, "helper")), \
                mock.patch.object(secure_local.patch_legacy_security, "apply"), \
                mock.patch.object(secure_local.subprocess, "run", return_value=mock.Mock(returncode=0)), \
                mock.patch.object(secure_local, "replace_registration") as replace, \
                mock.patch.object(secure_local, "doctor", return_value=True), \
                mock.patch.object(secure_local, "wait_for_idle") as wait:
            secure_local.apply(self.root, target, 0)
        wait.assert_called_once_with(0, ports=(8788,))
        self.assertEqual(replace.call_args.args[2], f"gui/{os.getuid()}/{secure_local.LEGACY_LABEL}")


if __name__ == "__main__":
    unittest.main()
