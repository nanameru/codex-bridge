#!/usr/bin/env bash
# Codex を codex-bridge 経由に切り替える / 元に戻す
#
#   ./switch.sh on     ブリッジ経由にする
#   ./switch.sh off    元の設定に戻す
#
# config.toml は毎回バックアップを取ってから書き換える。
set -euo pipefail

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CFG="$CODEX_HOME/config.toml"
CATALOG="$CODEX_HOME/model-catalog.json"
BACKUP="$CFG.bak.switch"
PORT="${PORT:-8788}"

usage() { echo "使い方: $0 on|off"; exit 1; }
[ $# -eq 1 ] || usage
[ -f "$CFG" ] || { echo "config.toml が見つかりません: $CFG"; exit 1; }

cp "$CFG" "$BACKUP"

CODEX_HOME="$CODEX_HOME" CATALOG="$CATALOG" PORT="$PORT" MODE="$1" python3 - <<'PY'
import os, re, pathlib

mode = os.environ["MODE"]
catalog = os.environ["CATALOG"]
port = os.environ["PORT"]
p = pathlib.Path(os.environ["CODEX_HOME"]) / "config.toml"
s = p.read_text()

# 既存の切り替え痕跡を除去
s = re.sub(r'^model_provider = "codex-bridge"\n', '', s, flags=re.M)
s = re.sub(r'^model_catalog_json = ".*"\n', '', s, flags=re.M)
s = re.sub(r'\n\[model_providers\.codex-bridge\]\n(?:.*\n)*?(?=\n\[|\Z)', '\n', s)

if mode == "on":
    s = re.sub(r'^(model = ".*")$',
               lambda m: f'{m.group(1)}\nmodel_provider = "codex-bridge"\nmodel_catalog_json = "{catalog}"',
               s, count=1, flags=re.M)
    s = s.rstrip() + f"""

[model_providers.codex-bridge]
name = "Codex Bridge (OpenCode Go)"
base_url = "http://127.0.0.1:{port}/v1"
wire_api = "responses"
"""
p.write_text(s)
print("→ ブリッジ経由" if mode == "on" else "→ 元の設定に戻した")
PY

echo "バックアップ: $BACKUP"
if command -v codex >/dev/null 2>&1; then
  cd /tmp && codex features list >/dev/null 2>/tmp/codex-bridge-cfg.err \
    && echo "config 検証: OK" \
    || { echo "config 検証: NG"; head -3 /tmp/codex-bridge-cfg.err; exit 1; }
fi

case "$(uname -s)" in
  Darwin)
    codex app-server daemon restart >/dev/null 2>&1 || true
    osascript -e 'tell application "ChatGPT" to quit' 2>/dev/null || true
    sleep 3
    open -a ChatGPT 2>/dev/null || true
    ;;
esac
echo "完了"
