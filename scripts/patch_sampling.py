"""Remove injected sampling defaults while preserving unrelated legacy upgrades."""
import argparse
from pathlib import Path
import re
import shutil
import subprocess
import time
from switch_config import atomic_write

OLD = 'if (body.temperature != null) chatBody.temperature = body.temperature;'
NEW = '''// Explicit sampling values are opt-in; model defaults differ across providers.
for (const field of ["temperature", "top_p", "frequency_penalty", "presence_penalty"]) {
  if (body[field] != null) chatBody[field] = body[field];
  else delete chatBody[field];
}'''


def patched_source(source):
    if source.count(NEW.splitlines()[0]) == 1 and OLD not in source:
        # Require the complete block, including indentation, rather than its marker alone.
        normalized = '\n'.join(line.lstrip() for line in source.splitlines())
        if '\n'.join(line.lstrip() for line in NEW.splitlines()) not in normalized:
            raise ValueError('samplingの更新が不完全です。変更しません')
        return source
    if source.count(OLD) != 1 or NEW.splitlines()[0] in source:
        raise ValueError('samplingの更新箇所が想定と異なります。変更しません')
    match = re.search(r'(?m)^([ \t]*)' + re.escape(OLD) + r'$', source)
    if not match:
        raise ValueError('samplingの更新形式が想定と異なります。変更しません')
    indent = match.group(1)
    return source[:match.start()] + '\n'.join(indent + line for line in NEW.splitlines()) + source[match.end():]


def apply(target):
    if target.is_symlink() or target.parent.is_symlink():
        raise ValueError('リンク先は変更しません')
    source = target.read_text()
    updated = patched_source(source)
    subprocess.run([shutil.which('node') or 'node', '--check', '--input-type=module'],
                   input=updated, text=True, capture_output=True, check=True)
    if source == updated:
        return 'unchanged'
    if target.read_text() != source:
        raise ValueError('元ファイルが同時に変更されました')
    atomic_write(target.with_name(target.name + '.bak.sampling.' + str(time.time_ns())), source)
    atomic_write(target, updated, target.stat().st_mode & 0o777)
    return 'applied'


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('target', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.apply:
        print(apply(args.target))
        print('ファイルを確認しました。サービスは再起動していません。')
    else:
        patched_source(args.target.read_text())
        print('適用可能です。変更するには--applyを指定してください。')
