# Issue #132 本番反映と認証調査（2026-10-28）

## 本番反映
- ユーザーの本番反映依頼に基づき、通信がidleになった時点で8791を更新。8790/8791のimplementationは253bc49bf129be1fda6d97e0025d41d846bf9bf36d3cb9bd954c2a4f051b7fb8。
- 両healthはhistory_mode=selected、summary_model=gpt-6-luna。後者は明示的なOpenAI方式用であり、外部モデルselected方式の要約ではOpenAIへ自動fallbackしない。
- 本人のauth.jsonの内容は配備前後で不変。実行中通信の強制終了なし。旧plistバックアップと配備receiptは本人のCODEX_HOME内へ保存。
- codex-plaintext-history --applyにより、今後の新規チャットのproviderをcodex-bridge、remote_compactionをunsupportedへ変更。既定モデル/接続先/認証を保持。既存会話の内容やproviderは自動変更していない。
- 設定バックアップ: ~/.codex/config.toml.bak.portable-history.f1iicj_7。
- codex-handoffとcodex-plaintext-historyを保護されたimmutableディレクトリへ導入。残存ログ/手動メモからローカルに部分引き継ぎ可能。元ログが不足する場合に完全復元は保証しない。

## 追加発見と修正
動的モデル一覧が47件から53件へ変化し、保存一覧との完全一致gateで設定反映が停止した。動的一覧の場合は保護版serviceの検証を維持し、現在選択中のモデルが稼働一覧に存在することを要求する。静的一覧は従来の完全一致。未選択・廃止モデル・非保護serviceの拒否を回帰テスト。

## 検証
- 先行変更: Node364件、Python147件、GPT/DeepSeekそれぞれ実Codex+mock上流の複数ターン/2回圧縮/resume/toolsが成功。PR #133の2件のCIは配備前SUCCESS。
- 追加変更: Python148件すべて成功、git diff --check成功。
- インストール済みcodex-plaintext-history --apply再実行はchanged=false。元設定の秘密情報は出力していない。
- 両ポートへの本人の現行token付き不正JSON probeは400 invalid_json。認証gate通過のみ確認し、外部モデルの推論/利用量は発生させていない。

## 401追加報告
画像の401はローカル認証gateの拒否。auth-doctorはfile storeでok。現行tokenは両ポートで通過するため、恒常的な認証読取不能ではない。起動済みCodexの保持tokenとファイルの更新後tokenの不一致が候補。ただし当該要求の秘密情報は収集しておらず、原因確定とはしない。
本人のauth.json更新時刻は2026-10-28 11:12頃。一部Codexプロセスは前日から稼働。全チャットのdaemonは停止していない。停止したチャットを抜けてcodex resume <ID> --no-daemonで再接続すると現在の認証を再読込できる（CLI helpでオプション確認）。実際の対象チャットでの復旧確認は未実施。

## GitHub反映
この記録作成時点でghは認証未設定と応答。Issueへの投稿は未完了。ユーザーの認証情報を別ユーザーや配布物へコピーしていない。
