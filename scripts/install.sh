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
codex_root="${CODEX_HOME:-$HOME/.codex}"

echo "== 1. 環境確認 =="
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が必要です（20以上）"; exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node.js 20 以上が必要です（現在 $(node -v)）"; exit 1; }
echo "node $(node -v): OK"

if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import tomllib' >/dev/null 2>&1; then
  echo "Python 3.11以上が必要です（Codexの設定解析に使います）" >&2; exit 1
fi
echo "利用者本人のCodex認証を確認します（外部通信・認証情報の表示なし）。"
node "$ROOT/src/auth-doctor.mjs" --root "$codex_root"

echo "上流認証には公式APIキーを使います。ログインDBやOAuth情報は取り出しません。"

echo
echo "== 2. モデルカタログ生成 =="
mkdir -p "$codex_root"
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
