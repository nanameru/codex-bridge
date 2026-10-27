import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import rescue_handoff as rescue

THREAD = '01a17762-842c-7e31-9a87-e94813415601'


class RescueTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.folder = self.root / 'sessions/2026/10/28'
        self.folder.mkdir(parents=True)
        self.log = self.folder / ('rollout-test-' + THREAD + '.jsonl')

    def write_log(self, records):
        records = [{'type': 'session_meta', 'payload': {'id': THREAD}}, *records]
        self.log.write_text(''.join(json.dumps(r) + '\n' for r in records))
        return self.log.read_bytes()

    def message(self, text, role='user'):
        return {'type': 'response_item', 'payload': {'type': 'message', 'role': role,
                'content': [{'type': 'input_text' if role == 'user' else 'output_text', 'text': text}]}}

    def test_readable_context_memo_and_unknowns_without_modifying_original(self):
        original = self.write_log([self.message('目的と禁止事項'),
                                  {'type': 'response_item', 'payload': {'type': 'compaction', 'encrypted_content': 'OPAQUE_SECRET'}},
                                  {'type': 'response_item', 'payload': {'type': 'reasoning', 'text': 'HIDDEN_SECRET'}},
                                  {'type': 'response_item', 'payload': {'type': 'function_call_output', 'output': 'TOOL_SECRET'}},
                                  self.message('テスト成功。次はレビュー', 'assistant')])
        text, report = rescue.render(self.root, THREAD, '未完了: Issueへ検証結果を記録')
        for value in ('目的と禁止事項', 'テスト成功', '未完了', '部分復元', '確認してください'):
            self.assertIn(value, text)
        for value in ('OPAQUE_SECRET', 'HIDDEN_SECRET', 'TOOL_SECRET'):
            self.assertNotIn(value, text)
        self.assertEqual(report['openai_inference_requests'], 0)
        self.assertEqual(report['opaque_records'], 1)
        self.assertEqual(self.log.read_bytes(), original)

    def test_no_log_requires_memo_and_memo_only_is_explicit(self):
        with self.assertRaises(ValueError):
            rescue.render(self.root, THREAD)
        text, report = rescue.render(self.root, THREAD, '目的: テストを直す。削除は禁止。')
        self.assertFalse(report['source_found'])
        self.assertIn('元ログなし', text)
        path = rescue.save(self.root, text)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)

    def test_large_context_keeps_recent_and_marks_loss(self):
        self.write_log([self.message(str(i) + 'x' * 4000) for i in range(20)])
        text, report = rescue.render(self.root, THREAD)
        self.assertGreater(report['omitted_records'], 0)
        self.assertIn('19xxxx', text)
        self.assertNotIn('0xxxx', text)
        self.assertLess(len(text), 26000)

    def test_rollback_wrong_thread_fork_and_malformed_records_stop(self):
        self.write_log([self.message('old'), {'type': 'event_msg', 'payload': {'type': 'thread_rollback'}}])
        with self.assertRaises(ValueError):
            rescue.render(self.root, THREAD)
        for source in [
            json.dumps({'type': 'session_meta', 'payload': {'id': 'other'}}) + '\n',
            json.dumps({'type': 'session_meta', 'payload': {'id': THREAD, 'forked_from_id': 'other'}}) + '\n',
            '{malformed}\n',
        ]:
            self.log.write_text(source)
            with self.assertRaises(ValueError):
                rescue.render(self.root, THREAD, 'memo')

    def test_links_unsafe_inputs_and_duplicate_logs_are_refused(self):
        self.write_log([self.message('private')])
        self.log.chmod(0o666)
        with self.assertRaises(ValueError):
            rescue.render(self.root, THREAD)
        self.log.chmod(0o600)
        archived = self.root / 'archived_sessions'
        archived.mkdir()
        (archived / self.log.name).write_bytes(self.log.read_bytes())
        with self.assertRaises(ValueError):
            rescue.render(self.root, THREAD)
        with self.assertRaises(ValueError):
            rescue.render(self.root, '../invalid')
        link = self.root / 'memo'
        link.symlink_to(self.log)
        with self.assertRaises(OSError):
            rescue.safe_read(link, 10000)

    def test_partial_last_record_ignored_and_plaintext_summary_kept(self):
        self.write_log([{'type': 'compacted', 'payload': {'message': '保存済み判断'}}, self.message('latest')])
        with self.log.open('a') as output:
            output.write('{"incomplete"')
        text, report = rescue.render(self.root, THREAD)
        self.assertIn('保存済み判断', text)
        self.assertIn('latest', text)
        self.assertEqual(report['incomplete_records'], 1)

    def test_launch_requires_external_model_and_plaintext_provider(self):
        (self.root / 'unified-model-catalog.json').write_text(json.dumps({'models': [
            {'slug': 'gpt-test', 'router_provider': 'openai'},
            {'slug': 'opencode/deepseek-test', 'router_provider': 'opencode'}]}))
        config = self.root / 'config.toml'
        config.write_text('[model_providers.codex-bridge]\nbase_url="http://127.0.0.1:8791/v1"\n'
                          'requires_openai_auth=true\nwire_api="responses"\n'
                          '[model_providers.codex-bridge.capabilities]\nremote_compaction="unsupported"\n')
        config.chmod(0o600)
        path = self.root / 'handoff.md'
        args = rescue.launch_args(self.root, path, 'opencode/deepseek-test')
        self.assertIn('opencode/deepseek-test', args)
        self.assertIn(str(path), args[-1])
        self.assertNotIn('resume', args)
        for model in ('gpt-test', None, 'unknown'):
            with self.assertRaises(ValueError):
                rescue.launch_args(self.root, path, model)
        config.write_text(config.read_text().replace('unsupported', 'v2'))
        with self.assertRaises(ValueError):
            rescue.launch_args(self.root, path, 'opencode/deepseek-test')


if __name__ == '__main__':
    unittest.main()
