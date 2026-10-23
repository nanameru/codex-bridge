"""Run the offline gates and write a per-case receipt for Issue/CI review."""
import argparse
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]


class InventoryResult(unittest.TextTestResult):
    def __init__(self, *args):
        super().__init__(*args)
        self.cases = []

    def record(self, test, status):
        self.cases.append({'name': test.id(), 'status': status,
                           'file': 'test/' + test.id().split('.')[0] + '.py'})

    def addSuccess(self, test):
        super().addSuccess(test)
        self.record(test, 'pass')

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.record(test, 'fail')

    def addError(self, test, err):
        super().addError(test, err)
        self.record(test, 'error')

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self.record(test, 'skip')


def run(output):
    output.mkdir(parents=True, exist_ok=True)
    paths = sorted((ROOT / 'test').glob('*.test.mjs'))
    source = {path: path.read_text() for path in paths}
    node = subprocess.run(['node', '--test', '--test-reporter=tap', *map(str, paths)],
                          cwd=ROOT, text=True, capture_output=True)
    (output / 'node.tap').write_text(node.stdout + node.stderr)
    cases = []
    for line in node.stdout.splitlines():
        match = re.match(r'^(not ok|ok) \d+ - (.*)$', line)
        if not match:
            continue
        name = re.sub(r' # (SKIP|TODO).*$', '', match[2])
        path = next((path for path, text in source.items() if name in text), None)
        cases.append({'name': name, 'status': 'skip' if ' # SKIP' in match[2] else 'pass' if match[1] == 'ok' else 'fail',
                      'file': str(path.relative_to(ROOT)) if path else 'test/'})
    # Keep unittest's complete output separate from individual result metadata.
    suite = unittest.defaultTestLoader.discover(str(ROOT / 'test'), pattern='test_*.py')
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=2, resultclass=InventoryResult).run(suite)
    (output / 'python.txt').write_text(stream.getvalue())
    report = {'node': {'exit_code': node.returncode, 'cases': cases},
              'python': {'successful': result.wasSuccessful(), 'count': result.testsRun, 'cases': result.cases}}
    (output / 'inventory.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    escape = lambda value: str(value).replace('|', '\\|').replace('\n', ' ')
    lines = ['# オフラインテスト全件一覧', '',
             '生成: `python3 scripts/run_test_inventory.py --output test-results`。実API・app-server E2Eは別表。', '',
             '| 種別 | テストファイル | ケース | 結果 |', '|---|---|---|---|']
    for kind, entries in [('Node', cases), ('Python', result.cases)]:
        lines.extend('| ' + ' | '.join(map(escape, [kind, row['file'], row['name'], row['status']])) + ' |' for row in entries)
    (output / 'inventory.md').write_text('\n'.join(lines) + '\n')
    print(f'Node={len(cases)} cases (exit={node.returncode}); Python={result.testsRun} cases (success={result.wasSuccessful()})')
    return 0 if node.returncode == 0 and result.wasSuccessful() else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'test-results')
    arguments = parser.parse_args()
    raise SystemExit(run(arguments.output))
