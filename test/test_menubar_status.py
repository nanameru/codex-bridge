"""メニューバーアプリが呼ぶコマンド（#188）。模擬のCODEX_HOME・HOME・ポートだけを使う。"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import plistlib
import socket
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[1]
STATUS = ROOT / "scripts/menubar_status.py"
SECRET = "sk-synthetic-menubar-1234567890"


def serve(payload):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class MenubarStatusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.codex = self.home / ".codex"
        self.codex.mkdir(mode=0o700)
        self.env = {**os.environ, "HOME": str(self.home), "CODEX_HOME": str(self.codex)}
        self.servers = []

    def tearDown(self):
        for server in self.servers:
            server.shutdown()
            server.server_close()
        self.temp.cleanup()

    def server(self, payload):
        server = serve(payload)
        self.servers.append(server)
        return server.server_address[1]

    def status(self, router_port, bridge_port):
        result = subprocess.run([sys.executable, str(STATUS), "--router-port", str(router_port),
                                 "--bridge-port", str(bridge_port)],
                                env=self.env, capture_output=True, text=True, timeout=30, check=True)
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        self.assertNotIn(str(self.home), result.stdout)  # パスは返さない
        return json.loads(result.stdout)

    def write_private(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_text(text)
        os.chmod(path, 0o600)

    def test_ac01_running_and_stopped_with_version(self):
        until = int(time.time() * 1000) + 3600_000
        router = self.server({"ok": True, "mode": "unified", "implementation": "e52b6d5b87afdb356d3ef1f3dbef820a",
                              "history_mode": "selected", "summary_limit_until": until})
        bridge = self.server({"ok": True, "security": "local-owner-v1"})
        agents = self.home / "Library/LaunchAgents"
        agents.mkdir(parents=True)
        (agents / "com.kimurataiyou.codex-model-router.plist").write_bytes(plistlib.dumps(
            {"ProgramArguments": ["/node", str(self.codex / "router-runtime" / ("ab" * 32) / "model-router.mjs")]}))
        value = self.status(router, bridge)
        self.assertEqual(value["router"]["running"], True)
        self.assertEqual(value["router"]["implementation"], "e52b6d5b87af")
        self.assertEqual(value["router"]["revision"], "ab" * 6)
        self.assertEqual(value["bridge"]["running"], True)
        self.assertEqual(value["summary_limit"], {"openai_limited": True, "until": until, "source": "router",
                                                  "recent_fallbacks": 0, "last_fallback_requests_ago": None})
        stopped = self.status(free_port(), free_port())
        self.assertFalse(stopped["router"]["running"])
        self.assertIsNone(stopped["router"]["implementation"])
        self.assertFalse(stopped["bridge"]["running"])

    def test_ac01_a_non_router_server_is_not_shown_as_the_router(self):
        # 8791番の簡易サーバーのように、/healthが200でもmode=unifiedでなければルーターではない。
        other = self.server({"ok": True})
        value = self.status(other, free_port())
        self.assertFalse(value["router"]["running"])

    def test_ac03_limit_and_provider_breakdown_from_log_and_state(self):
        now = int(time.time() * 1000)
        lines = [
            {"event": "router_request", "provider": "commandcode", "history_mode": "selected"},
            {"event": "router_request", "provider": "openai", "remote_compaction_fallback": "selected",
             "remote_compaction_openai_status": 429},
            {"event": "catalog_refresh", "status": "ok"},
            {"event": "router_request", "provider": "commandcode"},
        ]
        self.write_private(self.codex / "log/model-router.log",
                           "\n".join(json.dumps(line) for line in lines) + "\nnot json\n")
        self.write_private(self.codex / "provider-fallback-state.json", json.dumps({"version": 1, "providers": {
            "opencode": {"windows": {"5h": {"until": now + 600_000, "reason": "http_429"}}},
            "ollama": {"windows": {"5h": {"until": now - 1, "reason": "http_429"}}}}}))
        self.write_private(self.codex / "commandcode-api-key", SECRET + "\n")
        # 解除時刻を返さない古いルーター
        router = self.server({"ok": True, "mode": "unified", "history_mode": "openai"})
        value = self.status(router, free_port())
        self.assertEqual(value["providers"]["counts"], {"commandcode": 2, "openai": 1})
        self.assertEqual(value["providers"]["recent_requests"], 3)
        self.assertEqual(list(value["providers"]["limited_until"]), ["opencode"])
        self.assertEqual(value["summary_limit"]["source"], "log")
        self.assertIsNone(value["summary_limit"]["openai_limited"])
        self.assertEqual(value["summary_limit"]["recent_fallbacks"], 1)
        self.assertEqual(value["summary_limit"]["last_fallback_requests_ago"], 2)
        self.assertEqual(value["keys"], {"commandcode": True, "ollama": False})

    def test_history_mode_file_is_validated(self):
        self.assertEqual(self.status(free_port(), free_port())["history_mode"], "selected")
        self.write_private(self.codex / "bridge-history-mode.json", json.dumps({"version": 1, "mode": "ask"}))
        self.assertEqual(self.status(free_port(), free_port())["history_mode"], "ask")
        os.chmod(self.codex / "bridge-history-mode.json", 0o644)
        self.assertEqual(self.status(free_port(), free_port())["history_mode"], "invalid")

    def test_ac02_history_mode_command_changes_the_shown_mode(self):
        for mode in ["openai", "ask", "selected"]:
            subprocess.run(["node", str(ROOT / "src/history-mode.mjs"), "--mode", mode], env=self.env,
                           check=True, capture_output=True, timeout=30)
            shown = subprocess.run(["node", str(ROOT / "src/history-mode.mjs")], env=self.env,
                                   check=True, capture_output=True, text=True, timeout=30).stdout
            self.assertEqual(json.loads(shown[:shown.rindex("}") + 1])["mode"], mode)
            self.assertEqual(self.status(free_port(), free_port())["history_mode"], mode)

    def test_ac04_key_from_stdin_is_never_printed_or_passed_as_argument(self):
        arguments = [sys.executable, str(ROOT / "scripts/manual_providers.py"), "--codex-home", str(self.codex),
                     "set-key", "ollama", "--stdin"]
        process = subprocess.Popen(arguments, env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        seen = subprocess.run(["ps", "-o", "args=", "-p", str(process.pid)], capture_output=True, text=True).stdout
        out, err = process.communicate(SECRET + "\n", timeout=30)
        self.assertEqual(process.returncode, 0, err)
        self.assertNotIn(SECRET, seen + out + err)
        self.assertNotIn(SECRET, " ".join(arguments))
        path = self.codex / "ollama-api-key"
        self.assertEqual(path.read_text(), SECRET + "\n")
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        # 改行を含む・空の入力は保存せず、元の鍵を残す。エラー出力にも鍵を出さない。
        failed = subprocess.run(arguments, env=self.env, input="\n", capture_output=True, text=True, timeout=30)
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(path.read_text(), SECRET + "\n")
        self.assertNotIn(SECRET, failed.stdout + failed.stderr)
        self.assertTrue(self.status(free_port(), free_port())["keys"]["ollama"])
        # ルーターが読まない鍵（他人も読める・空・空白入り）は「登録済み」にしない。
        os.chmod(path, 0o644)
        self.assertFalse(self.status(free_port(), free_port())["keys"]["ollama"])
        for bad in ["\n", "two words\n"]:
            self.write_private(path, bad)
            self.assertFalse(self.status(free_port(), free_port())["keys"]["ollama"])

    def test_ac05_toggle_waits_for_an_active_conversation_without_cutting_it(self):
        self.check_toggle_waits(on_bridge=False)

    def test_ac05_toggle_also_waits_for_a_conversation_on_the_bridge(self):
        # ルーターが空いていても、ブリッジ（8788相当）で会話中なら待つ。
        self.check_toggle_waits(on_bridge=True)

    def check_toggle_waits(self, on_bridge):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        client = socket.create_connection(("127.0.0.1", port))
        conversation, _ = listener.accept()
        router_port = free_port() if on_bridge else port
        bridge_port = port if on_bridge else free_port()
        source = '[model_providers.codex-bridge]\nbase_url = "http://127.0.0.1:%d/v1"\n' % router_port
        self.write_private(self.codex / "config.toml", source)
        self.write_private(self.codex / "unified-router-state.json", json.dumps({
            "root": {"openai_base_url": None, "model_catalog_json": None},
            "bridge": {"base_url": "http://127.0.0.1:8788/v1", "requires_openai_auth": None, "wire_api": "responses"},
            "bridge_existed": True}))
        toggle = subprocess.Popen([sys.executable, str(ROOT / "scripts/unified_config.py"), "off", "--port", str(router_port),
                                   "--bridge-port", str(bridge_port), "--wait-idle", "60"], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True)
        try:
            time.sleep(2)
            self.assertIsNone(toggle.poll(), "会話中は切り替えを待つ")
            self.assertEqual((self.codex / "config.toml").read_text(), source)
            client.sendall(b"still-talking")
            self.assertEqual(conversation.recv(64), b"still-talking")  # 接続は切れていない
            client.close()
            conversation.close()
            out, err = toggle.communicate(timeout=30)
        finally:
            if toggle.poll() is None:
                toggle.kill()
            listener.close()
        self.assertEqual(toggle.returncode, 0, err)
        self.assertIn("会話の接続が空くまで待機します", out)
        self.assertIn("統合ルーティング: off", out)
        self.assertEqual(tomllib.loads((self.codex / "config.toml").read_text())["model_providers"]["codex-bridge"]["base_url"],
                         "http://127.0.0.1:8788/v1")
        self.assertFalse(self.status(free_port(), free_port())["unified"]["enabled"])

    def test_ac05_wait_idle_is_bounded(self):
        result = subprocess.run([sys.executable, str(ROOT / "scripts/unified_config.py"), "off", "--wait-idle", "1801"],
                                env=self.env, capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("0〜1800", result.stderr)


if __name__ == "__main__":
    unittest.main()
