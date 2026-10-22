import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import queue
import tempfile
import tomllib
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("live_smoke", Path(__file__).with_name("live-router-smoke.py"))
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)


class FakeServer:
    def __init__(self, status="completed", tool=False):
        self.calls = []
        self.messages = queue.Queue()
        self.count = 0
        self.status = status
        self.tool = tool

    def send(self, message):
        pass

    def request(self, method, params):
        self.calls.append((method, params))
        if method == "thread/start":
            self.count += 1
            return {"thread": {"id": str(self.count)}}
        if method == "turn/start":
            thread = params["threadId"]
            events = [("item/agentMessage/delta", {"delta": "private-answer"}),
                      ("thread/tokenUsage/updated", {"tokenUsage": {"last": {"inputTokens": 100, "cachedInputTokens": 0}}})]
            if self.tool:
                events.append(("item/completed", {"item": {"type": "commandExecution"}}))
            events.append(("turn/completed", {"turn": {"id": thread, "status": self.status,
                                                     "error": {"message": "private-error"}}}))
            for name, event in events:
                self.messages.put({"method": name, "params": {"threadId": thread, **event}})
            return {"turn": {"id": thread}}
        return {}


class ComparisonTests(unittest.TestCase):
    def test_equal_conditions_fresh_history_and_no_prompt_override(self):
        for reverse in (False, True):
            server = FakeServer()
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                SMOKE.compare_latency(server, "/isolated-work", gpt_first=reverse)
            rows = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual([row["repetition"] for row in rows], [1, 1, 2, 2])
            self.assertEqual(rows[0]["model"], "gpt-6.1-sol" if reverse else "opencode/deepseek-v4.1-flash")
            starts = [params for method, params in server.calls if method == "thread/start"]
            turns = [params for method, params in server.calls if method == "turn/start"]
            self.assertEqual(len({turn["threadId"] for turn in turns}), 4)
            self.assertTrue(all("baseInstructions" not in start and start["cwd"] == "/isolated-work" for start in starts))
            self.assertTrue(all(turn["effort"] == "low" and turn["input"] == turns[0]["input"] for turn in turns))
            self.assertTrue(all(row["tool_calls"] == 0 and row["usage"]["cachedInputTokens"] == 0 for row in rows))
            self.assertNotIn("private", output.getvalue())

    def test_error_or_tool_use_stops_without_printing_content(self):
        for server in (FakeServer(status="failed"), FakeServer(tool=True)):
            output = io.StringIO()
            with contextlib.redirect_stdout(output), self.assertRaises(RuntimeError):
                SMOKE.compare_latency(server, "/isolated-work")
            self.assertEqual(server.count, 1)
            self.assertNotIn("private", output.getvalue())

    def test_comparison_is_explicitly_opt_in(self):
        with mock.patch.dict(os.environ, {"LIVE_ROUTER_COMPARE": "1"}, clear=True):
            with mock.patch.object(SMOKE, "LocalServer") as server, self.assertRaisesRegex(SystemExit, "4回"):
                SMOKE.main()
            server.assert_not_called()

    def test_old_router_is_rejected_before_model_calls(self):
        with mock.patch.dict(os.environ, {"LIVE_ROUTER_COMPARE": "1", "RUN_LIVE_ROUTER": "1"}, clear=True):
            with mock.patch.object(SMOKE, "isolated_login", return_value=contextlib.nullcontext()), \
                    mock.patch.object(SMOKE, "urlopen", return_value=io.StringIO('{"ok":true}')), \
                    mock.patch.object(SMOKE, "LocalServer") as server:
                with self.assertRaisesRegex(RuntimeError, "公式Responses"):
                    SMOKE.main()
                server.assert_not_called()

    def test_isolated_settings_preserve_global_instructions_and_original_home(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = {"models": [{"slug": "gpt-6.1-sol"},
                                  {"slug": "opencode/deepseek-v4.1-flash", "router_transport": "responses"}]}
            for name, content in {"auth.json": "{}", "unified-model-catalog.json": json.dumps(catalog),
                                  "AGENTS.md": "existing instructions", "config.toml": "original"}.items():
                (root / name).write_text(content)
            with mock.patch.dict(os.environ, {"CODEX_HOME": directory}, clear=True):
                with SMOKE.isolated_login(comparison=True):
                    isolated = Path(os.environ["CODEX_HOME"])
                    config = tomllib.loads((isolated / "config.toml").read_text())
                    self.assertEqual(config["model_provider"], "codex-bridge")
                    self.assertEqual(config["model_providers"]["codex-bridge"]["http_headers"]["x-codex-bridge-direct"], "1")
                    self.assertEqual((isolated / "AGENTS.md").read_text(), "existing instructions")
                    self.assertEqual((isolated / "auth.json").stat().st_mode & 0o777, 0o600)
                self.assertEqual(os.environ["CODEX_HOME"], directory)
            self.assertEqual((root / "config.toml").read_text(), "original")


if __name__ == "__main__":
    unittest.main()
