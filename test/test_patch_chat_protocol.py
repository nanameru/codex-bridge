import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from patch_chat_protocol import HELPERS, MANIFEST, ROOT, patched_source, apply, read_manifest


LEGACY = '''import http from "node:http";
const guardBridgeRequest = () => true;
const SSE_HEARTBEAT_MS = 15000, UPSTREAM_FIRST_BYTE_TIMEOUT_MS = 60000, UPSTREAM_IDLE_TIMEOUT_MS = 60000;
function rawTimeoutHandler() { return "preserve raw timeout and authentication"; }
function toChatMessages(body) {
  return body.input;
}
function toChatTools(body) {
  return body.tools;
}
function toResponsesPayload(chat, model) {
  return chat;
}
async function pipeStream(upstreamRes, res, model, threadId, abortHandle) {
  return "old conversion";
}
async function handler(req, res, body, model, threadId, activeHandle, attempt, chat) {
  if (!guardBridgeRequest(req, res)) return;
  const messages = toChatMessages(body);
  const chatBody = { messages, tools: toChatTools(body) };
  if (body.tool_choice) chatBody.tool_choice = body.tool_choice;
  await pipeStream(attempt.upstream, res, model, threadId, activeHandle);
  const payload = toResponsesPayload(chat, model);
  return payload;
}
'''


class ChatProtocolPatchTests(unittest.TestCase):
    def test_patch_is_idempotent_and_preserves_other_legacy_functions(self):
        source = (ROOT / 'src/codex-bridge.mjs').read_text()
        self.assertEqual(patched_source(source), source)
        self.assertIn('guardBridgeRequest', source)
        self.assertNotIn('答える前に必ず手順を確認', source)

    def test_legacy_keeps_abort_handle_and_timeouts_and_passes_tool_context(self):
        patched = patched_source(LEGACY)
        self.assertEqual(patched_source(patched), patched)
        self.assertIn('async function pipeStream(upstreamRes, res, model, threadId, abortHandle, toolContext)', patched)
        self.assertIn('await pipeStream(attempt.upstream, res, model, threadId, activeHandle, toolContext);', patched)
        self.assertIn('firstByteTimeoutMs: UPSTREAM_FIRST_BYTE_TIMEOUT_MS, idleTimeoutMs: UPSTREAM_IDLE_TIMEOUT_MS, toolContext', patched)
        self.assertIn('return chatToResponses(chat, model, toolContext);', patched)
        self.assertIn('const payload = toResponsesPayload(chat, model, toolContext);', patched)
        self.assertIn('toolChoice = chatToolChoice(body.tool_choice, toolContext);', patched)
        self.assertIn('if (toolChoice !== undefined) chatBody.tool_choice = toolChoice;', patched)
        self.assertIn('res.writeHead(422', patched)
        self.assertIn('return chatToolContext(body).tools;', patched)
        self.assertIn('function rawTimeoutHandler() { return "preserve raw timeout and authentication"; }', patched)
        self.assertIn('if (!guardBridgeRequest(req, res)) return;', patched)
        subprocess.run(['node', '--check', '--input-type=module'], input=patched, text=True, capture_output=True, check=True)

    def test_previous_managed_guard_migrates_without_duplicate_imports(self):
        previous_guard = '''let messages, toolContext, toolChoice;
  try {
    toolContext = chatToolContext(body);
    toolChoice = chatToolChoice(body.tool_choice, toolContext);
    messages = toChatMessages(body);
  } catch {
    res.writeHead(422, { "content-type": "application/json" });
    res.end(JSON.stringify({error:{type:"unsupported_tool_search",message:"このツール検索または履歴はChat経路で安全に変換できません。履歴は保持しています。"}}));
    return;
  }'''
        previous = ('import { chatToolContext, chatToolChoice } from "./tool-search.mjs";\n'
                    + LEGACY.replace('const messages = toChatMessages(body);', previous_guard))
        patched = patched_source(previous)
        self.assertEqual(patched_source(patched), patched)
        self.assertEqual(patched.count('import { chatToolContext'), 1)
        self.assertIn('code:toolFailure ? error.reasonCode', patched)
        self.assertIn('理由: ${toolFailure ? error.reasonCode', patched)
        self.assertNotIn('このツール検索または履歴はChat経路', patched)
        subprocess.run(['node', '--check', '--input-type=module'], input=patched, text=True, capture_output=True, check=True)

    def test_deployed_legacy_fallback_normalizes_tools_and_preserves_fetch_arguments(self):
        call = 'attempt = await doFetch("/responses", { ...body, model }, authInfo.token, clientAbort.signal, upstreamSession(body, SESSION_ID));'
        source = LEGACY.replace('  return payload;', '  ' + call + '\n  return payload;')
        patched = patched_source(source)
        self.assertIn('toolChoiceForTools(body.tool_choice, body.tools)', patched)
        self.assertIn('attempt = await doFetch("/responses", responsesBody, authInfo.token, clientAbort.signal, upstreamSession(body, SESSION_ID));', patched)
        self.assertEqual(patched_source(patched), patched)

    def test_drift_refused_and_backups_created_once(self):
        with self.assertRaises(ValueError):
            patched_source('unrecognized')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'bridge.mjs'
            source = (ROOT / 'src/codex-bridge.mjs').read_text()
            target.write_text(source)
            apply(target)
            apply(target)
            self.assertEqual(target.read_text(), source)
            for name in HELPERS:
                self.assertEqual((root / name).read_bytes(), (ROOT / 'src' / name).read_bytes())
            manifest = read_manifest(root / MANIFEST)
            self.assertEqual(list(manifest), list(HELPERS))
            self.assertEqual(manifest, {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in HELPERS})
            self.assertEqual(list(root.glob('*.bak.*')), [])
            for name in HELPERS:
                with self.subTest(helper=name):
                    module = root / name
                    original = module.read_bytes()
                    module.write_text('unknown change')
                    before = target.read_bytes()
                    with self.assertRaisesRegex(ValueError, '管理外'):
                        apply(target)
                    self.assertEqual(target.read_bytes(), before)
                    module.write_bytes(original)

    def test_old_manifest_migrates_and_dependencies_resolve_without_repo_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'bridge.mjs'
            target.write_text(LEGACY)
            old = root / 'chat-protocol.mjs'
            old.write_text('export const oldHelper = true;\n')
            (root / MANIFEST).write_text(hashlib.sha256(old.read_bytes()).hexdigest() + '\n')
            apply(target)
            self.assertEqual(set(read_manifest(root / MANIFEST)), set(HELPERS))
            self.assertEqual(len(list(root.glob('bridge.mjs.bak.*'))), 1)
            self.assertEqual(len(list(root.glob('chat-protocol.mjs.bak.*'))), 1)
            before = sorted(path.name for path in root.glob('*.bak.*'))
            apply(target)
            self.assertEqual(sorted(path.name for path in root.glob('*.bak.*')), before)
            # The helper must resolve all relative imports in the deployment dir.
            subprocess.run(['node', '--input-type=module', '-e',
                'const p=await import(process.argv[1]); if(typeof p.chatToResponses!=="function")process.exit(1)',
                (root / 'chat-protocol.mjs').as_uri()], cwd=root, check=True, capture_output=True)

    def test_unknown_dependency_and_symlinks_are_refused_before_any_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'bridge.mjs'
            target.write_text(LEGACY)
            (root / 'usage.mjs').write_text('unmanaged')
            with self.assertRaisesRegex(ValueError, '管理外'):
                apply(target)
            self.assertEqual(target.read_text(), LEGACY)
            (root / 'usage.mjs').unlink()
            (root / 'tool-search.mjs').symlink_to(target)
            with self.assertRaisesRegex(ValueError, 'リンク'):
                apply(target)
            self.assertFalse((root / 'chat-protocol.mjs').exists())


if __name__ == '__main__':
    unittest.main()
