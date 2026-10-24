from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import patch_sampling as patch


class SamplingPatchTests(unittest.TestCase):
    def source(self):
        return 'const body = {}; const chatBody = {};\n  ' + patch.OLD + '\n// keep other upgrades\n'

    def test_exact_idempotent_replacement_preserves_other_upgrades(self):
        result = patch.patched_source(self.source())
        self.assertIn('else delete chatBody[field]', result)
        self.assertIn('// keep other upgrades', result)
        self.assertEqual(patch.patched_source(result), result)
        for source in ['', self.source() + patch.OLD, result.replace('else delete chatBody[field];', '')]:
            with self.assertRaises(ValueError):
                patch.patched_source(source)

    def test_apply_has_private_exact_backup_and_syntax_failure_leaves_original(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'bridge.mjs'
            target.write_text(self.source())
            target.chmod(0o600)
            original = target.read_text()
            self.assertEqual(patch.apply(target), 'applied')
            self.assertEqual(patch.apply(target), 'unchanged')
            backups = list(target.parent.glob('*.bak.sampling.*'))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_text(), original)
            self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            target.write_text(self.source())
            with mock.patch.object(patch.subprocess, 'run', side_effect=RuntimeError('syntax failure')):
                with self.assertRaises(RuntimeError):
                    patch.apply(target)
            self.assertEqual(target.read_text(), original)
            link = target.with_name('link.mjs'); link.symlink_to(target)
            with self.assertRaises(ValueError):
                patch.apply(link)
