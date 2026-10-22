from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from patch_legacy_bridge import (
    IMPORT,
    MISSING_REASONING,
    REASONING_REPLACEMENTS,
    REPLACEMENTS,
    patched_source,
    prepare,
    main,
)


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
            self.assertEqual(target.read_text(), "export {};\n")
            backups = list(Path(directory).glob("upstream-options.mjs.bak.latency.*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), previous)

    def test_patches_only_known_fragments_and_is_idempotent(self):
        source = "\n".join(old * count for old, _new, count in REPLACEMENTS)
        source += "\n" + "\n".join(old * count for old, _new, count in REASONING_REPLACEMENTS)
        source += "\nPRESERVE_REASONING_AND_TIMEOUTS"
        result = patched_source(source)
        self.assertIn(IMPORT, result)
        self.assertIn(MISSING_REASONING, result)
        self.assertIn("let pendingAssistant = null;", result)
        self.assertIn("PRESERVE_REASONING_AND_TIMEOUTS", result)
        self.assertEqual(patched_source(result), result)
        self.assertEqual(result.count("upstreamSession(body, SESSION_ID)"), 3)

    def test_refuses_source_drift_and_partial_patches(self):
        with self.assertRaises(ValueError):
            patched_source("unrecognized source")
        with self.assertRaises(ValueError):
            patched_source(IMPORT)
        original = "\n".join(old * count for old, _new, count in REPLACEMENTS)
        original += "\n" + "\n".join(old * count for old, _new, count in REASONING_REPLACEMENTS)
        complete = patched_source(original)
        for old, new, _count in REPLACEMENTS[1:]:
            with self.subTest(fragment=old):
                with self.assertRaises(ValueError):
                    patched_source(complete.replace(new, old, 1))
        for old, new, _count in REASONING_REPLACEMENTS:
            with self.subTest(reasoning_fragment=old[:40]):
                with self.assertRaises(ValueError):
                    patched_source(original.replace(old, new, 1))

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


if __name__ == "__main__":
    unittest.main()
