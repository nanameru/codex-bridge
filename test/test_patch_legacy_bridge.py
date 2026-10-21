from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from patch_legacy_bridge import IMPORT, REPLACEMENTS, patched_source, prepare


class LegacyPatchTests(unittest.TestCase):
    def test_patches_only_known_fragments_and_is_idempotent(self):
        source = "\n".join(old * count for old, _new, count in REPLACEMENTS)
        source += "\nPRESERVE_REASONING_AND_TIMEOUTS"
        result = patched_source(source)
        self.assertIn(IMPORT, result)
        self.assertIn("PRESERVE_REASONING_AND_TIMEOUTS", result)
        self.assertEqual(patched_source(result), result)
        self.assertEqual(result.count("upstreamSession(body, SESSION_ID)"), 3)

    def test_refuses_source_drift_and_partial_patches(self):
        with self.assertRaises(ValueError):
            patched_source("unrecognized source")
        with self.assertRaises(ValueError):
            patched_source(IMPORT)
        original = "\n".join(old * count for old, _new, count in REPLACEMENTS)
        complete = patched_source(original)
        for old, new, _count in REPLACEMENTS[1:]:
            with self.subTest(fragment=old):
                with self.assertRaises(ValueError):
                    patched_source(complete.replace(new, old, 1))

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
