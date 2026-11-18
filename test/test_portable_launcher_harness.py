import errno
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch, Mock

import portable_launcher_harness as harness
from build_distribution import build, FILES


class PortableLauncherHarnessTests(unittest.TestCase):
    def setUp(self):
        workspace = tempfile.TemporaryDirectory(prefix="test-tc125-")
        self.addCleanup(workspace.cleanup)
        self.work = Path(workspace.name).resolve()

    def test_archive_must_match_release_digest_and_excludes_harness(self):
        source = self.work / "trusted.zip"
        digest = build(harness.ROOT, source)
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            harness.prepare_archive(source, "0" * 64, self.work)
        self.assertFalse((self.work / "distribution").exists())

        extracted = harness.prepare_archive(source, digest, self.work)
        self.assertEqual({str(p.relative_to(extracted)) for p in extracted.rglob("*") if p.is_file()},
                         {*FILES, "MANIFEST.json"})
        self.assertEqual((extracted / "scripts/portable_setup.py").read_bytes(),
                         (harness.ROOT / "scripts/portable_setup.py").read_bytes())

    def test_mac_sandbox_denies_egress_except_two_loopback_ports(self):
        with patch.object(harness.os, "access", return_value=True):
            command = harness.sandbox_command("darwin", self.work, (18788, 18999), ["worker"])
        self.assertEqual(command[:2], ["/usr/bin/sandbox-exec", "-p"])
        self.assertIn("(deny network*)", command[2])
        self.assertEqual([line for line in command[2].splitlines() if "network-outbound" in line],
                         ['(allow network-outbound (remote ip "localhost:18788"))',
                          '(allow network-outbound (remote ip "localhost:18999"))'])
        self.assertEqual(command[3:], ["worker"])

    def test_linux_uses_private_network_and_requires_bubblewrap(self):
        with patch.object(harness.shutil, "which", return_value="/usr/bin/bwrap"):
            command = harness.sandbox_command("linux", self.work, (18788, 18999), ["worker"])
        self.assertIn("--unshare-net", command)
        self.assertIn("--unshare-pid", command)
        self.assertEqual(command[-2:], ["--", "worker"])
        with patch.object(harness.shutil, "which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "network isolation unavailable"):
                harness.sandbox_command("linux", self.work, (18788, 18999), ["worker"])

    def test_session_wraps_only_exact_bridge_and_requires_synthetic_key(self):
        tool = self.work / "fake Node's binary"
        tool.write_text('#!/bin/sh\nprintf "%s\\n" "$UPSTREAM_BASE" "$CODEX_BRIDGE_TEST_UPSTREAM" "$@"\n',
                        encoding="utf-8")
        tool.chmod(0o700)
        with patch.dict(harness.os.environ, {"UPSTREAM_BASE": "inherited", "OPENAI_API_KEY": "inherited"}):
            config, answer, env = harness.prepare_session(self.work, str(tool), str(tool), 18999)
        self.assertNotIn("UPSTREAM_BASE", env)
        self.assertNotIn("OPENAI_API_KEY", env)
        auth = config.with_name("auth.json")
        self.assertEqual(auth.stat().st_mode & 0o077, 0)
        self.assertEqual(json.loads(auth.read_text())["OPENAI_API_KEY"], harness.CODEX_KEY)
        node = self.work / "bin/node"
        bridge = self.work / "distribution/src/codex-bridge.mjs"
        auth_probe = bridge.with_name("auth-doctor.mjs")

        def call(wrapper, *args, key=harness.MOCK_KEY):
            return subprocess.run([wrapper, *args], env={**env, "OPENCODE_API_KEY": key},
                                  capture_output=True, text=True)

        session = call(node, bridge)
        self.assertEqual(session.returncode, 0)
        self.assertEqual(session.stdout.splitlines(), ["http://127.0.0.1:18999/v1", "1", str(bridge)])
        self.assertEqual(call(node, bridge, key="wrong-key").returncode, 1)
        self.assertEqual(call(node, auth_probe).stdout.splitlines(), ["", "", str(auth_probe)])
        codex = call(self.work / "bin/codex", "-c", "sample=1")
        self.assertEqual(codex.returncode, 0)
        lines = codex.stdout.splitlines()
        self.assertEqual(lines[:5], ["", "", "-c", "sample=1", "exec"])
        self.assertIn(str(answer), lines)

    def test_loopback_permission_error_is_not_a_closed_port(self):
        with patch.object(harness.socket, "socket") as socket:
            socket.return_value.__enter__.return_value.connect_ex.return_value = errno.EACCES
            with self.assertRaises(OSError):
                harness.port_is_open(18788)

    def test_mock_startup_failure_does_not_run_launcher(self):
        with (patch.object(harness.socket, "if_nameindex", return_value=[(1, "lo")]),
              patch.object(harness, "port_is_open", return_value=False),
              patch.object(harness.subprocess, "Popen") as popen,
              patch.object(harness.subprocess, "run") as run):
            popen.return_value.poll.return_value = 1
            with self.assertRaisesRegex(RuntimeError, "mock upstream did not become ready"):
                harness.exercise(self.work, "/node", "/codex", 18788, 18999)
        run.assert_not_called()

    def test_linux_rejects_non_loopback_interfaces_before_spawning(self):
        with (patch.object(harness.sys, "platform", "linux"),
              patch.object(harness.socket, "if_nameindex", return_value=[(1, "lo"), (2, "eth0")]),
              patch.object(harness.subprocess, "Popen") as popen):
            with self.assertRaisesRegex(RuntimeError, "non-loopback interface"):
                harness.exercise(self.work, "/node", "/codex", 18788, 18999)
        popen.assert_not_called()

    def test_launch_sequence_checks_response_stop_and_config(self):
        def record_run(command, **kwargs):
            if command[4] == "run":
                (self.work / "last-message.txt").write_text(harness.ANSWER)
                (self.work / "mock.log").write_text("[mock] POST /v1/chat/completions model: fixture\n")

        child = Mock()
        child.poll.return_value = None
        with (patch.object(harness.socket, "if_nameindex", return_value=[(1, "lo")]),
              patch.object(harness, "port_is_open", return_value=False) as check_port,
              patch.object(harness, "wait_for_mock"),
              patch.object(harness.subprocess, "Popen", return_value=child),
              patch.object(harness.subprocess, "run", side_effect=record_run) as run,
              patch("builtins.print")):
            harness.exercise(self.work, "/node", "/codex", 18788, 18999)
        self.assertEqual([call.args[0][4] for call in run.call_args_list], ["preflight", "preview", "run"])
        self.assertEqual([call.args[0] for call in check_port.call_args_list], [18788, 18999, 18788, 18999])
        child.terminate.assert_called_once()
        child.wait.assert_called_once_with(timeout=5)
