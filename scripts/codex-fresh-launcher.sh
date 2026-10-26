#!/bin/sh
# A bare interactive launch reads current settings in its own server.
codex_binary="${HOME}/.codex/packages/standalone/current/bin/codex"
if [ "$#" -eq 0 ]; then
    exec "$codex_binary" --no-daemon
fi
exec "$codex_binary" "$@"
