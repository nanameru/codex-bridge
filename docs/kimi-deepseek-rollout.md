# Kimi・DeepSeekの通常起動（Issue #120）

2026-10-26、ユーザーの優先指示により全社モデルの汎用対応を切り離し、Kimi K3.1 Proと既存DeepSeekを先に反映した。

## 原因と変更

新しいzshだけに読み込まれる関数では、Herdrに残った古いshellの通常PATH起動を直せていなかった。公式installerが所有するvisible entryは公式バイナリ直結へ戻り得る。`install_fresh_cli.py`は既知の公式symlinkだけを安定launcherへ向け、既存PATHと新shellの両方を扱う。独自の起動ファイルは保持する。公式更新後の古いshellについては、新shellの管理関数と同じ保証にはならない。再インストールで既知の入口を修復できる。

Command Codeの正式なKimi IDは `moonshotai/Kimi-K3.1-Pro`。大文字・小文字を保持して一覧と転送先に登録した。DeepSeek固有のthinking/effortやsampling既定値をKimiへ混入させず、自動fallbackはDeepSeekに限定する。Kimiの画像入力とeffort段階の拡張は今回対象外。

## 本人Macへの反映

- 安定入口: `~/.codex/bridge-cli/bin/codex`。通常PATH入口 `~/.local/bin/codex` と `~/.zshenv` の管理関数から利用。
- 一覧: `~/.codex/unified-model-catalog.json`。既存モデルと既定モデルを保持してKimiを追加。
- 新規起動先: `http://127.0.0.1:8791/v1`。
- LaunchAgent: `com.kimurataiyou.codex-model-router-8791`。
- runtime revision: `c2c7992b4639fe790f75a4efb7040e81e089459a02a3f868a385d0b48b4adfd1`。
- 旧8790は実行中通信が残っているため保持。共有app-serverや既存会話の移行・archiveは行っていない。
- 稼働先に合わせて既存`~/.codex/bin/restart-model-router`と運用guideを8791へ更新。通常の状態確認は同helperの`--check`。再起動を連打しない。
- 設定、catalog、再起動helper、guideの変更前原文は本人専用backupに保存。ポインターは `~/.codex/backups/kimi-120-latest-path`。認証ファイルは変更していない。

移行開始時、idle判定が失敗した後もシェルの次行の旧router再起動が進んだ。旧版は正常復帰したが、手順上の誤りであり、以降の依存する反映操作は別の呼び出しで成功確認してから実行した。8790を再び停止せず、新8791を起動・認証拒否・revision検証してから新規接続先を更新した。

## 検証

- Node回帰342件、Python回帰138件成功。
- 実Codex＋模擬上流: 一覧、Kimi/DeepSeekを含む同一会話切替、圧縮後の選択保持、保存再開、認証分離成功（16要求、実APIなし）。
- 実`/model`: OpenCode DeepSeek (current)、Command Code DeepSeek、Ollama DeepSeek、Command Code Kimi K3.1 Proを確認。
- 新経路8791の実API: KimiはHTTP200、`response.completed`、`OK`、input89/output67。DeepSeekはHTTP200、completed、`OK`、input8/output1。小さい合成プロンプトのみ。
- さらに認証を隔離した実Codex app-serverから8791へ各モデルを選択し、両方`completed`/`OK`を確認。テスト用の一時設定は削除され、本人の既定モデルは保持。

すでに起動している画面の一覧や会話ロックを変更するものではない。上流の429や利用枠切れが今後起きないとは保証しない。長い既存履歴、画像、全MCPの組み合わせはこの短い疎通確認の保証範囲外。
