from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from patch_legacy_bridge import ERROR_HEADERS, IMPORT, REPLACEMENTS, patched_source, prepare, main
from patch_legacy_bridge import GUARD_IMPORT


class LegacyPatchTests(unittest.TestCase):
    def test_upgrades_known_helper_with_one_backup_and_preserves_bridge_source(self):
        repository = Path(__file__).resolve().parents[1]
        previous = (repository / "test/fixtures/upstream-options-v1.mjs").read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "bridge.mjs"
            target.write_text("export {};\n")
            module = target.with_name("upstream-options.mjs")
            module.write_bytes(previous)
            with mock.patch("patch_legacy_bridge.patched_source", side_effect=lambda source: source), \
                    mock.patch.object(sys, "argv", ["patch_legacy_bridge.py", str(target), "--apply"]):
                main()
                main()
            self.assertEqual(module.read_bytes(), (repository / "src/upstream-options.mjs").read_bytes())
            guard_module = target.with_name("request-guard.mjs")
            self.assertEqual(guard_module.read_bytes(), (repository / "src/request-guard.mjs").read_bytes())
            self.assertEqual(target.read_text(), "export {};\n")
            backups = list(Path(directory).glob("upstream-options.mjs.bak.latency.*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), previous)
            self.assertEqual(list(Path(directory).glob("request-guard.mjs.bak.latency.*")), [])

    def test_patches_only_known_fragments_and_is_idempotent(self):
        source = 'import http from "node:http";\n'
        source += "\n".join(old * count for old, _new, count in REPLACEMENTS)
        source += "\nPRESERVE_REASONING_AND_TIMEOUTS"
        result = patched_source(source)
        self.assertIn(IMPORT, result)
        self.assertIn(GUARD_IMPORT, result)
        self.assertEqual(result.count(IMPORT), 1)
        self.assertIn("PRESERVE_REASONING_AND_TIMEOUTS", result)
        self.assertEqual(patched_source(result), result)
        self.assertEqual(result.count("upstreamSession(body, SESSION_ID)"), 3)
        self.assertIn("requestGuard.check(threadId)", result)
        self.assertNotIn("guardTripped", result)

    def test_adds_guard_to_already_patched_bridge_without_duplicating_imports(self):
        fragments = "\n".join(old * count for old, _new, count in REPLACEMENTS)
        already_patched = 'import http from "node:http";\n' + IMPORT + "\n" + fragments
        result = patched_source(already_patched)
        self.assertEqual(result.count(IMPORT), 1)
        self.assertEqual(result.count(GUARD_IMPORT), 1)
        self.assertEqual(patched_source(result), result)

    def test_refuses_source_drift_and_partial_rewrites(self):
        with self.assertRaises(ValueError):
            patched_source("unrecognized source")
        with self.assertRaises(ValueError):
            patched_source(IMPORT)
        original = 'import http from "node:http";\n'
        original += "\n".join(old * count for old, _new, count in REPLACEMENTS)
        complete = patched_source(original)
        chat_call = 'doFetch("/chat/completions", chatBody, authInfo.token, clientAbort.signal)'
        chat_call_new = next(new for old, new, _count in REPLACEMENTS if old == chat_call)
        with self.assertRaises(ValueError):
            patched_source(complete.replace(chat_call_new, chat_call, 1))

    def test_reapplies_single_missing_fragment(self):
        original = 'import http from "node:http";\n'
        original += "\n".join(old * count for old, _new, count in REPLACEMENTS)
        complete = patched_source(original)
        reverted = complete.replace("presence_penalty: 0.1,\n        ...reasoningOptions(model, body.reasoning?.effort),",
                                    "presence_penalty: 0.1,", 1)
        self.assertEqual(patched_source(reverted), complete)

    def test_refuses_symlinks_and_existing_different_modules_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "bridge.mjs"
            target.write_text("unchanged")
            link = root / "link.mjs"
            link.symlink_to(target)
            with self.assertRaises(ValueError):
                prepare(link)
            module = root / "upstream-options.mjs"
            module.write_text("unrelated module")
            with self.assertRaises(ValueError):
                prepare(target)
            self.assertEqual(target.read_text(), "unchanged")
            self.assertEqual(module.read_text(), "unrelated module")

    def test_preserves_retry_after_when_adding_thread_guard(self):
        original = 'import http from "node:http";\n' + "\n".join(old * count for old, _new, count in REPLACEMENTS)
        original += "\n" + ERROR_HEADERS[0]
        result = patched_source(original)
        self.assertIn(ERROR_HEADERS[1], result)
        self.assertEqual(patched_source(result), result)


if __name__ == "__main__":
    unittest.main()
