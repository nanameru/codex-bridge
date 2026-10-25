# CLIのモデル選択同期と利用再開案内（Issue #93）

## 確認した動作

Codex CLI 0.164.0を、隔離CODEX_HOME・合成認証・専用Unix socket・専用tmuxで起動。
OpenCode → Command Code → Ollama → OpenCodeの選択設定と実CLI footerが追従した。
固定モデルを手動で行き来しても自動用項目と混同せず、固定選択を優先する。

自動用の選択IDは`auto-commandcode/deepseek-v4.1-flash`と`auto-ollama/deepseek-v4.1-flash`。
自動モードはCodex自身が保存する選択IDに含め、別の会話ID対応表・購読・DB編集を行わない。
既存CLIが古いカタログを保持する場合も選択IDが更新されることを確認した。
その場合はID表記となり、共有サーバー/CLIの再起動後に新しい表示名を取り込む。
他チャットを停止する再起動は自動実行しない。

## 実画面の抜粋

```text
Command Code · DeepSeek V4.1 Flash（自動切替）
Ollama Cloud · DeepSeek V4.1 Flash（自動切替）
OpenCode · DeepSeek V4.1 Flash
```

Ollamaを未課金に見立てた模擬402の実CLI表示:

```text
unexpected status 402 Payment Required: Ollama Cloudが要求を拒否しました
ログイン https://ollama.com/signin ／ プラン・支払い https://ollama.com/pricing
```

切替継続時も、枠に達した提供元の公式リンクをbridge commentaryとして表示した。
次の推論からはbridge固有IDで除外し、toolのcall_idとindexを維持する。
画面全文はテスト実行時の`test-results/cli-sync-*.txt`へ生成する（合成データのみ）。

## 検証コマンド

```sh
node --test test/cli-*.test.mjs test/provider-help.test.mjs test/provider-fallback-router.test.mjs
python3 -m unittest discover -s test -p test_manual_providers.py
python3 test/cli-model-sync-e2e.py
CODEX_TEST_STALE_CATALOG=1 python3 test/cli-model-sync-e2e.py
python3 scripts/run_test_inventory.py --output test-results
```

control socketの所有者/権限、RPC期限とサイズ、不正WS frame、逆方向requestの非実行、
手動選択優先、再接続、全社枯渇、公式URL固定化、配布モジュールの完全性を検証した。

## 検証中に見つけた問題

初期実装でカタログからGoルートを取り直した際にChat経路制限を迂回してしまい、
短い確認要求が実OpenCode APIへ到達した。本人に説明し、Issueへ記録した。
正確な使用量/金額は未確認。購入・契約変更・本番反映は行っていなかった。

当該分岐を廃止し、自動チェーンのGo候補を必ずChatに固定。
テストには外部宛送信禁止ガードと、直接APIの認証関数を呼んだら失敗する回帰テストを追加した。
以降の合格E2Eはガード付き模擬上流のみで実行した。
