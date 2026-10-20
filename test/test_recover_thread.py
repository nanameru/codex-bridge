import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import test_switch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("recover_thread", ROOT / "scripts/recover_thread.py")
RECOVERY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RECOVERY)


class LegacySwitchTests(test_switch.SwitchTests):
    script = ROOT / "scripts/legacy-switch.sh"

    def setUp(self):
        super().setUp()
        self.environment["CODEX_BRIDGE_HOME"] = str(ROOT)


class FakeServer:
    def __init__(self, provider="codex-bridge", status="notLoaded", destination="openai"):
        self.provider = provider
        self.status = status
        self.destination = destination
        self.calls = []

    def send(self, message):
        self.calls.append(message)

    def request(self, method, params):
        self.calls.append({"method": method, "params": params})
        if method == "thread/read":
            return {"thread": {"id": "original", "modelProvider": self.provider,
                               "status": {"type": self.status}, "name": "作業"}}
        if method == "thread/fork":
            return {"thread": {"id": "restored", "modelProvider": self.destination},
                    "modelProvider": self.destination, "model": params["model"]}
        return {}


class RecoveryTests(unittest.TestCase):
    def test_handles_missing_or_invalid_thread_metadata(self):
        for response in [{}, {"thread": None}, {"thread": {}}, {"thread": {"id": ""}}, None]:
            with self.subTest(response=response), self.assertRaisesRegex(RuntimeError, "thread"):
                RECOVERY.thread_from_response(response)

    def test_handles_missing_fork_metadata_without_naming_a_thread(self):
        server = FakeServer()
        original = server.request("thread/read", {})
        with mock.patch.object(server, "request", side_effect=[{}, original, {}]) as request:
            with self.assertRaisesRegex(RuntimeError, "thread"):
                RECOVERY.recover(server, "original", "gpt-test")
        self.assertEqual([call.args[0] for call in request.call_args_list], [
            "initialize", "thread/read", "thread/fork",
        ])

    def test_kills_only_its_child_if_graceful_shutdown_times_out(self):
        server = RECOVERY.LocalServer.__new__(RECOVERY.LocalServer)
        server.process = mock.Mock()
        expired = RECOVERY.subprocess.TimeoutExpired("fake-codex", 5)
        server.process.wait.side_effect = [expired, expired, 0]
        server.close()
        server.process.terminate.assert_called_once_with()
        server.process.kill.assert_called_once_with()
        server.process.stdout.close.assert_called_once_with()
        self.assertEqual(server.process.wait.call_count, 3)

    def test_accepts_native_reasoning_and_codex_models(self):
        with tempfile.TemporaryDirectory() as directory:
            for model in ["o1", "o3", "o4-mini", "codex-mini-latest"]:
                with self.subTest(model=model):
                    Path(directory, "config.toml").write_text(f'model="{model}"\n')
                    with mock.patch.dict(RECOVERY.os.environ, {"CODEX_HOME": directory}), mock.patch(
                        "sys.argv", ["recover_thread.py", "original"]
                    ), mock.patch.object(RECOVERY, "LocalServer") as server, mock.patch.object(
                        RECOVERY, "recover", return_value={"model": model}
                    ) as recover, mock.patch("builtins.print"):
                        RECOVERY.main()
                        recover.assert_called_once_with(server.return_value, "original", model)
                        server.return_value.close.assert_called_once_with()

    def test_rejects_bridge_defaults_before_opening_a_server(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "config.toml").write_text('model="gpt-test"\nmodel_provider="codex-bridge"\n')
            with mock.patch.dict(RECOVERY.os.environ, {"CODEX_HOME": directory}), mock.patch(
                "sys.argv", ["recover_thread.py", "original"]
            ), mock.patch.object(RECOVERY, "LocalServer") as server:
                with self.assertRaisesRegex(ValueError, "既定の接続先"):
                    RECOVERY.main()
                server.assert_not_called()

    def test_rejects_non_native_model_before_opening_a_server(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "config.toml").write_text('model="deepseek-test"\n')
            with mock.patch.dict(RECOVERY.os.environ, {"CODEX_HOME": directory}), mock.patch(
                "sys.argv", ["recover_thread.py", "original"]
            ), mock.patch.object(RECOVERY, "LocalServer") as server:
                with self.assertRaisesRegex(ValueError, "モデル"):
                    RECOVERY.main()
                server.assert_not_called()

    def test_forks_history_to_openai_without_starting_a_turn(self):
        server = FakeServer()
        result = RECOVERY.recover(server, "original", "gpt-test")
        self.assertEqual(result["threadId"], "restored")
        self.assertEqual(result["modelProvider"], "openai")
        self.assertEqual(result["name"], "通常Codexで再開: 作業")
        calls = [call for call in server.calls if call["method"] == "thread/fork"]
        self.assertEqual(calls[0]["params"], {
            "threadId": "original", "model": "gpt-test", "modelProvider": "openai", "excludeTurns": True,
        })
        self.assertEqual([call["method"] for call in server.calls], [
            "initialize", "initialized", "thread/read", "thread/fork", "thread/name/set",
        ])

    def test_refuses_running_original_without_mutating_it(self):
        server = FakeServer(status="active")
        with self.assertRaisesRegex(ValueError, "実行中"):
            RECOVERY.recover(server, "original", "gpt-test")
        self.assertNotIn("thread/fork", [call["method"] for call in server.calls])

    def test_refuses_a_thread_that_already_uses_openai(self):
        server = FakeServer(provider="openai")
        with self.assertRaisesRegex(ValueError, "接続ではありません"):
            RECOVERY.recover(server, "original", "gpt-test")
        self.assertNotIn("thread/fork", [call["method"] for call in server.calls])

    def test_checks_returned_provider(self):
        server = FakeServer(destination="codex-bridge")
        with self.assertRaisesRegex(RuntimeError, "接続先"):
            RECOVERY.recover(server, "original", "gpt-test")
        self.assertNotIn("thread/name/set", [call["method"] for call in server.calls])

    def test_reads_notifications_and_server_errors_over_stdio(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "fake-codex"
            executable.write_text('''#!/usr/bin/env python3
import json, sys
for line in sys.stdin:
    message = json.loads(line)
    print(json.dumps({"method": "notification"}), flush=True)
    if "id" in message:
        response = {"id": message["id"], "result": {"ok": True}}
        if message["method"] == "fail":
            response = {"id": message["id"], "error": {"message": "test error"}}
        print(json.dumps(response), flush=True)
''')
            executable.chmod(0o755)
            server = RECOVERY.LocalServer(str(executable))
            try:
                self.assertEqual(server.request("hello", {}), {"ok": True})
                with self.assertRaisesRegex(RuntimeError, "test error"):
                    server.request("fail", {})
            finally:
                server.close()
            self.assertEqual(server.process.returncode, 0)


if __name__ == "__main__":
    unittest.main()
