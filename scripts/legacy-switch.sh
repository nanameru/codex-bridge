#!/usr/bin/env bash
set -euo pipefail

BRIDGE_ROOT="${CODEX_BRIDGE_HOME:-$HOME/codex-bridge}"
SWITCH_SCRIPT="$BRIDGE_ROOT/scripts/switch.sh"
if [ ! -x "$SWITCH_SCRIPT" ]; then
  echo "修正版の切替スクリプトが見つかりません: $SWITCH_SCRIPT" >&2
  exit 1
fi
exec "$SWITCH_SCRIPT" "$@"
