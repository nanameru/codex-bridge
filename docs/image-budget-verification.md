# 画像による413誤拒否の修正（Issue #53）

## 該当スレッドの確認

ローカル履歴で、画像と一致する413（推定1,257,247 / 上限1,000,000、tools61個 / 1,665,510bytes）を特定した。履歴・アプリDBは読み取りのみ。別チャットへの送信・履歴改変はしていない。

- 最後の `view_image` 並列結果に約561KB・約2.47MBの画像が含まれていた。
- 過去のユーザー添付にも約1.23MB・約2.02MBの画像がある。
- 顧客会話・画像・思考本文は外部に送っていない。以下の試験上流は模擬API。

## 原因と修正

1. `estimateInputTokens` はリクエスト全体を文字列として概算し、画像Base64を文章のtokenとして計上していた。既知のuser添付・ツール結果の画像位置に限り、1枚8192tokenの保守的予約と本文の概算を分離した。これは全モデル共通の正確なtoken数/上限ではない。
2. `chatMessages` はツール結果配列をJSON文字列にし、画像をvision入力でなく長大なBase64文章として送っていた。tool roleのcall_id・テキストを保持し、全並列結果の後に関連ID付きuser画像ブロックとして送る。画像バイト列・detailを保持する。

DeepSeek公式では画像のtoken数は寸法ベースで、Base64の転送容量とは別。またChat画像はuserメッセージを使う。参照: https://api-docs.deepseek.com/guides/vision/

元の履歴をローカルで再構成した588items（toolsなし・要約なし）の比較は旧2,330,545→新585,353。これはスクリーンショット時点のwire要求の完全再現ではない。

## 検証

修正前は、合成3MB画像3枚の要求をローカル413で拒否し、並列ツール画像がJSON文字列化される試験も失敗。修正後は成功。

- `python3 scripts/run_test_inventory.py --output test-results`: Node118 / Python81、全199件成功。
- `LEGACY_BRIDGE_SOURCE=... node --test test/bridge-transport.test.mjs`: 稼働旧ソースの一時コピー＋実router→模擬Chat APIで3MB画像2枚が同一画像URL・call_idのまま到達。
- `python3 test/chat-bridge-app-e2e.py`: 実Codex app-server＋実Chat bridge→模擬上流で既存27要求成功。通常処理・反復回復・待機8回・可変引数・打切り0ツール。
- shell構文・Pythonコンパイル・git diff --check成功。
- TC-040〜042へ紐付け。全ケースは `docs/test-inventory.md`、生のケース別結果はCIの `case-results` artifact。

## 安全境界と残る確認

通常文章やschema内のBase64、不正画像文字列は安易に減算しない。リクエストの32MB転送制限とテキストの予算保護は維持する。上限を無効化したり、ツール・指示を削除したりしない。

実API試験は0要求。該当スレッドへ代わりに入力していないため、修正後の実スレッドでの再開成功・実モデルの画像認識精度は未確認。#51のHY4結果照合失敗も本件で解決した扱いにはしない。
