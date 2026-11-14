#!/usr/bin/env python3
"""Build and read back a deterministic, explicitly allowlisted recipient ZIP."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = (
    'LICENSE', 'START_HERE.md', 'AGENTS.md',
    'scripts/portable_setup.py', 'scripts/portable_router.mjs', 'scripts/portable_catalog.mjs',
    'scripts/unified_config.py', 'scripts/switch_config.py', 'scripts/local_security.py',
    'scripts/realtime_config.py',
    'src/auth-doctor.mjs', 'src/codex-bridge.mjs', 'src/chat-protocol.mjs',
    'src/tool-search.mjs', 'src/usage.mjs', 'src/local-security.mjs',
    'src/provider-help.mjs', 'src/upstream-options.mjs', 'src/request-guard.mjs',
    'src/prices.json', 'src/models.json', 'src/model-router.mjs',
    'src/tool-adapter.mjs', 'src/compaction-handoff.mjs', 'src/tool-recovery.mjs',
    'src/handoff-status.mjs', 'src/history-mode.mjs', 'src/rollout-history.mjs',
    'src/selected-compaction.mjs', 'src/live-catalog.mjs', 'src/make-catalog.mjs',
    'src/catalog-safety.mjs', 'src/sync-models.mjs', 'src/manual-providers.mjs',
    'src/cli-model-sync.mjs', 'src/cli-control.mjs', 'src/whatstoken-free.mjs',
    'src/provider-fallback.mjs',
)
SOURCE_MAP = {'START_HERE.md': 'distribution/START_HERE.md', 'AGENTS.md': 'distribution/AGENTS.md'}
MANIFEST = 'MANIFEST.json'
# Additional checks are defense in depth. The fixed allowlist is the boundary.
SENSITIVE = re.compile(rb'(?i)(?:-----BEGIN (?:RSA |EC |OPENSSH |PRIVATE )?PRIVATE KEY-----|sk-[A-Za-z0-9_-]{24,}|/Users/[A-Za-z0-9_.-]+/|/home/[A-Za-z0-9_.-]+/|[A-Z]:\\\\Users\\\\[^\\\\]+\\\\)')


def safe_name(name):
    p = PurePosixPath(name)
    return bool(name) and not p.is_absolute() and all(x not in ('', '.', '..') for x in name.split('/')) and '\\' not in name and ':' not in name


def read_source(root, name):
    if not safe_name(name):
        raise ValueError('invalid archive path')
    path = Path(root)
    root_info = path.lstat()
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode) or getattr(root_info, 'st_file_attributes', 0) & 0x400:
        raise ValueError('unsafe source root')
    for index, part in enumerate(name.split('/')):
        path = path / part
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('source link is forbidden: ' + name)
        if index < len(name.split('/')) - 1 and not stat.S_ISDIR(info.st_mode):
            raise ValueError('source parent is not a directory: ' + name)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('source must be a single-link regular file: ' + name)
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    fd = os.open(path, flags)
    with os.fdopen(fd, 'rb') as source:
        opened = os.fstat(source.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_nlink) != (info.st_dev, info.st_ino, info.st_mode, info.st_nlink):
            raise ValueError('source changed during read: ' + name)
        data = source.read()
    if SENSITIVE.search(data):
        raise ValueError('sensitive-looking content in allowlisted file: ' + name)
    return data


def entry(name, data):
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    info.compress_type = zipfile.ZIP_STORED
    return info, data


def readback(path, expected=None):
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        names = [i.filename for i in infos]
        required = list(FILES) + [MANIFEST]
        if names != required or len(set(names)) != len(names):
            raise ValueError('archive member list mismatch')
        for info in infos:
            if not safe_name(info.filename) or not stat.S_ISREG(info.external_attr >> 16):
                raise ValueError('unsafe archive member')
        manifest = json.loads(archive.read(MANIFEST))
        if set(manifest) != {'version', 'sha256'} or manifest['version'] != 1 or set(manifest['sha256']) != set(FILES):
            raise ValueError('invalid manifest')
        with tempfile.TemporaryDirectory(prefix='bridge-readback-') as temporary:
            for name in FILES:
                data = archive.read(name)
                digest = hashlib.sha256(data).hexdigest()
                if digest != manifest['sha256'][name] or (expected is not None and data != expected[name]):
                    raise ValueError('archive hash mismatch: ' + name)
                target = Path(temporary).joinpath(*name.split('/'))
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                    raise ValueError('extracted file hash mismatch: ' + name)
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def build(root, output):
    payload = {name: read_source(root, SOURCE_MAP.get(name, name)) for name in FILES}
    manifest = {'version': 1, 'sha256': {name: hashlib.sha256(data).hexdigest() for name, data in payload.items()}}
    output = Path(output).absolute()
    # Refuse links anywhere in the output parent path; never replace an existing file.
    for parent in (output.parent, *output.parent.parents):
        info = parent.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400 or not stat.S_ISDIR(info.st_mode):
            raise ValueError('unsafe output parent')
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'wb') as stream:
        with zipfile.ZipFile(stream, 'w') as archive:
            for name, data in payload.items():
                archive.writestr(*entry(name, data))
            archive.writestr(*entry(MANIFEST, (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()))
    return readback(output, payload)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='new ZIP path; existing files are never replaced')
    parser.add_argument('--verify', action='store_true', help='read back an existing ZIP instead of creating it')
    args = parser.parse_args()
    try:
        digest = readback(args.output) if args.verify else build(ROOT, args.output)
    except (OSError, ValueError, zipfile.BadZipFile, json.JSONDecodeError) as exc:
        parser.exit(1, 'distribution error: ' + str(exc) + '\n')
    print('SHA256:', digest)
    print('allowlist, manifest, extraction and hashes: OK')


if __name__ == '__main__':
    main()
