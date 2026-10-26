#!/usr/bin/env python3
"""Launch the sibling codex-real without inspecting user settings."""
import os
from pathlib import Path
import sys


# Codex 0.164.0: tui/src/cli.rs, utils/cli/src/shared_options.rs and
# cli/src/main.rs. Unknown options are passed through, never guessed.
VALUE_OPTIONS = {
    '-c', '--config', '--enable', '--disable', '-m', '--model',
    '--local-provider', '-p', '--profile', '-s', '--sandbox',
    '-C', '--cd', '--add-dir', '-a', '--ask-for-approval',
}
SHORT_VALUE_OPTIONS = {'c', 'm', 'p', 's', 'C', 'a', 'i'}
FLAGS = {
    '--strict-config', '--oss', '--approve-for-me', '--not-so-yolo',
    '--dangerously-bypass-approvals-and-sandbox', '--yolo',
    '--dangerously-bypass-hook-trust', '--worktree', '--search', '--no-alt-screen',
}
SESSION_FLAGS = {'--last', '--all', '--include-non-interactive'}
NON_TUI_COMMANDS = {
    'agents', 'tcp-tunnel', 'exec', 'e', 'review', 'login', 'logout', 'mcp',
    'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update',
    'doctor', 'sandbox', 'debug', 'execpolicy', 'apply', 'a', 'queue', 'archive',
    'delete', 'migrate-rollouts', 'migrate-nfs-db', 'unarchive', 'cloud',
    'cloud-tasks', 'responses-api-proxy', 'stdio-to-uds', 'exec-server',
    'features', 'help',
}


def rewrite_arguments(arguments):
    original = list(arguments)
    command = None
    index = 0
    while index < len(original):
        argument = original[index]
        if argument == '--':
            break  # All remaining values are literal, including flag-like prompts.
        if argument in {'--no-daemon', '-h', '--help', '-V', '--version'}:
            return original
        option, separator, value = argument.partition('=')
        if option in {'--remote', '--remote-auth-token-env'}:
            return original
        if argument in FLAGS or (argument in SESSION_FLAGS and command in {'resume', 'fork'}):
            index += 1
            continue
        if option in VALUE_OPTIONS:
            if separator:
                if not value:
                    return original
                index += 1
                continue
            if index + 1 >= len(original) or (original[index + 1].startswith('-') and original[index + 1] != '-'):
                return original
            index += 2
            continue
        # Attached short values (-mMODEL, -cKEY=VALUE) consume that token only.
        if argument.startswith('-') and not argument.startswith('--') and len(argument) > 2 and argument[1] in SHORT_VALUE_OPTIONS:
            index += 1
            continue
        if option == '--image' or argument == '-i':
            if separator:
                if not value:
                    return original
                index += 1
                continue
            # --image FILE... greedily consumes non-options. Codex does not
            # interpret an image value named "agents" or "resume" as a command.
            start = index + 1
            index = start
            while index < len(original) and (not original[index].startswith('-') or original[index] == '-'):
                index += 1
            if index == start:
                return original
            continue
        if argument.startswith('-') and argument != '-':
            return original  # Future/invalid option: let the real CLI validate it.
        if command is None:
            if argument in NON_TUI_COMMANDS:
                return original
            command = argument if argument in {'resume', 'fork'} else 'prompt'
        index += 1
    return ['--no-daemon', *original]


def main():
    try:
        launcher = Path(__file__).resolve(strict=True)
        real = launcher.with_name('codex-real').resolve(strict=True)
        if not real.is_file() or real == launcher or not os.access(real, os.X_OK):
            raise ValueError('invalid codex-real')
        os.execv(str(real), [str(real), *rewrite_arguments(sys.argv[1:])])
    except (OSError, RuntimeError, ValueError):
        print('codex-fresh: sibling codex-real is missing or not executable', file=sys.stderr)
        return 126


if __name__ == '__main__':
    raise SystemExit(main())
