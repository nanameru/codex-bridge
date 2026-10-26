"""Install the fresh CLI entry for both existing PATH lookups and new zsh shells."""
import json
import os
from pathlib import Path
import re
import shlex
import tempfile
import time

START = '# >>> codex-bridge fresh-cli (Issue #120)'
END = '# <<< codex-bridge fresh-cli (Issue #120)'


def write(path, data, mode=0o600):
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.fresh-cli-')
    try:
        with os.fdopen(fd, 'w') as out:
            os.fchmod(out.fileno(), mode)
            out.write(data)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install(home, source):
    root = home / '.codex'
    real = root / 'packages/standalone/current/bin/codex'
    stable = root / 'bridge-cli/bin'
    entry = stable / 'codex'
    visible = home / '.local/bin/codex'
    shell = home / '.zshenv'
    if not real.is_file() or not os.access(real, os.X_OK):
        raise ValueError('公式standalone Codexが必要です')
    if shell.is_symlink() or (visible.exists() and not visible.is_symlink()):
        raise ValueError('独自の起動ファイルは上書きしません')
    if visible.is_symlink() and visible.resolve() not in {real.resolve(), entry.resolve()}:
        raise ValueError('独自のcodexリンクは上書きしません')
    original = shell.read_text() if shell.exists() else ''
    block = f'{START}\nexport PATH={shlex.quote(str(stable))}:"$PATH"\nfunction codex() {{\n    {shlex.quote(str(entry))} "$@"\n}}\n{END}'
    if START in original or END in original:
        pattern = re.escape(START) + r'.*?' + re.escape(END)
        if original.count(START) != 1 or original.count(END) != 1 or not re.search(pattern, original, re.S):
            raise ValueError('管理ブロックが不正です')
        updated = re.sub(pattern, lambda _: block, original, flags=re.S)
    else:
        if re.search(r'(?:function\s+codex\b|\bcodex\s*\(\)|\balias\s+codex=)', original):
            raise ValueError('既存のcodex関数を確認してください')
        updated = original.rstrip('\n') + '\n\n' + block + '\n'
    launcher = source.read_text()
    if entry.exists() and entry.read_text() != launcher:
        raise ValueError('既存の独自launcherは上書きしません')
    sibling = stable / 'codex-real'
    if sibling.is_symlink() and sibling.resolve() != real.resolve() or sibling.exists() and not sibling.is_symlink():
        raise ValueError('独自の実行ファイルリンクは上書きしません')
    backup = root / 'backups' / ('fresh-cli-120-' + str(time.time_ns()))
    backup.mkdir(parents=True, mode=0o700)
    write(backup / 'zshenv.before', original)
    write(backup / 'entry.before.json', json.dumps({'visible_link': os.readlink(visible) if visible.is_symlink() else None}))
    stable.mkdir(parents=True, exist_ok=True, mode=0o700)
    write(entry, launcher, 0o700)
    if not sibling.exists():
        sibling.symlink_to(real)
    visible.parent.mkdir(parents=True, exist_ok=True)
    temporary = visible.with_name('.codex-fresh-' + str(time.time_ns()))
    temporary.symlink_to(entry)
    os.replace(temporary, visible)
    if updated != original:
        write(shell, updated)
    return backup


if __name__ == '__main__':
    print('fresh CLI installed; private backup: ' + str(install(Path.home(), Path(__file__).with_name('codex_fresh.py'))))
