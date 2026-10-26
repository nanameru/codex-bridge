#!/usr/bin/env bash
# codex-bridge のセットアップ
#
#   ./install.sh
#
# やること:
#   1. Node.js の確認
#   2. モデルカタログの生成（~/.codex/model-catalog.json）
#   3. 起動方法の案内
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

echo "== 1. 環境確認 =="
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が必要です（20以上）"; exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node.js 20 以上が必要です（現在 $(node -v)）"; exit 1; }
echo "node $(node -v): OK"

echo "上流認証には公式APIキーを使います。ログインDBやOAuth情報は取り出しません。"

echo
echo "== 2. モデルカタログ生成 =="
mkdir -p "$CODEX_HOME"
cd "$ROOT/src"
node make-catalog.mjs

echo
echo "== 3. 起動 =="
cat <<EOF
Kimi・DeepSeekを通常のcodexコマンドと/modelで使う場合:

  $ROOT/docs/distribution-setup.md

以下は単体OpenCodeブリッジの起動方法です:

別ターミナルで:

  cd $ROOT/src && node codex-bridge.mjs

Codex をブリッジ経由にする:

  $ROOT/scripts/switch.sh on

うまくいかないときは:

  node $ROOT/test/mock-upstream.mjs &            # 偽の上流
  OPENCODE_API_KEY=dummy UPSTREAM_BASE=http://127.0.0.1:8799/v1 \\
    node $ROOT/src/codex-bridge.mjs
EOF
