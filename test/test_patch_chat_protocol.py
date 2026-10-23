from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from patch_chat_protocol import patched_source, apply

class ChatProtocolPatchTests(unittest.TestCase):
    def test_patch_is_idempotent_and_preserves_other_legacy_functions(self):
        source = (Path(__file__).resolve().parents[1]/'src/codex-bridge.mjs').read_text()
        self.assertEqual(patched_source(source),source)
        self.assertIn('guardBridgeRequest',source)
        self.assertNotIn('答える前に必ず手順を確認',source)

    def test_drift_refused_and_backups_created_once(self):
        with self.assertRaises(ValueError):
            patched_source('unrecognized')
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            target=root/'bridge.mjs'
            source=(Path(__file__).resolve().parents[1]/'src/codex-bridge.mjs').read_text()
            target.write_text(source)
            apply(target)
            apply(target)
            self.assertEqual(target.read_text(),source)
            self.assertTrue((root/'chat-protocol.mjs').exists())
            self.assertEqual(list(root.glob('*.bak.*')),[])
            (root/'chat-protocol.mjs').write_text('unknown change')
            with self.assertRaises(ValueError):
                apply(target)

if __name__ == '__main__':
    unittest.main()
