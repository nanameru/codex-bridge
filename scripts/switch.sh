#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "使い方: $0 on|off|repair" >&2
  exit 1
fi
case "$1" in
  on|off|repair) ;;
  *) echo "使い方: $0 on|off|repair" >&2; exit 1 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$SCRIPT_DIR/switch_config.py" "$1"
