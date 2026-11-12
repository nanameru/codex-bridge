#!/usr/bin/env bash
# メニューバーアプリを手元でビルドする（署名・配布はしない）。
#   ./macos/CodexBridgeMenu/build.sh          → build/CodexBridgeMenu.app
#   ./macos/CodexBridgeMenu/build.sh --test   → 画面以外の処理のテストだけ
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="${BUILD_DIR:-$HERE/build}"
TARGET="arm64-apple-macos14.0"
[ "$(uname -m)" = "x86_64" ] && TARGET="x86_64-apple-macos14.0"
LOGIC=("$HERE/Sources/BridgeStatus.swift" "$HERE/Sources/Commands.swift")
mkdir -p "$OUT"

if [ "${1:-}" = "--test" ]; then
  xcrun swiftc -swift-version 5 -target "$TARGET" "${LOGIC[@]}" "$HERE/Tests/main.swift" -o "$OUT/logic-tests"
  exec "$OUT/logic-tests"
fi

# 子プロセスで呼ぶ Python 3.11 以上と Node の場所を、ビルド時に Info.plist へ書く。
PYTHON="${CODEX_BRIDGE_PYTHON:-}"
if [ -z "$PYTHON" ]; then
  for candidate in "$(command -v python3 || true)" "$(uv python find 3.12 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
      PYTHON="$candidate"; break
    fi
  done
fi
[ -n "$PYTHON" ] || { echo "Python 3.11 以上が見つかりません。CODEX_BRIDGE_PYTHON で指定してください" >&2; exit 1; }
NODE="${CODEX_BRIDGE_NODE:-$(command -v node || true)}"
[ -n "$NODE" ] || { echo "Node.js が見つかりません。CODEX_BRIDGE_NODE で指定してください" >&2; exit 1; }

APP="$OUT/CodexBridgeMenu.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
xcrun swiftc -swift-version 5 -O -target "$TARGET" -parse-as-library "${LOGIC[@]}" "$HERE/Sources/App.swift" \
  -o "$APP/Contents/MacOS/CodexBridgeMenu"

"$PYTHON" - "$APP/Contents/Info.plist" "$REPO" "$PYTHON" "$NODE" <<'EOF'
import plistlib, sys
path, repo, python, node = sys.argv[1:]
plistlib.dump({
    "CFBundleIdentifier": "local.codex-bridge.menu", "CFBundleName": "Codex Bridge",
    "CFBundleExecutable": "CodexBridgeMenu", "CFBundlePackageType": "APPL",
    "CFBundleShortVersionString": "0.1", "CFBundleVersion": "1",
    "LSMinimumSystemVersion": "14.0", "LSUIElement": True,
    "CodexBridgeRepository": repo, "CodexBridgePython": python, "CodexBridgeNode": node,
}, open(path, "wb"))
EOF
echo "$APP"
