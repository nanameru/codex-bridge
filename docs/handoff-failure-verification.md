# 履歴引き継ぎ502の診断と一時復帰（Issue #55）

## 現行Codexの会話IDと422の診断（Issue #177）

現行Codexでは`thread-id`が物理会話IDで、`session-id`や`prompt_cache_key`が同じ値とは限らない。`client_metadata["x-codex-turn-metadata"]`のJSON内の`session_id`にも実セッションのIDが入る。旧Bridgeは旧形式の`session_id`しか読まず、cache識別子を使って存在しないログを探し、履歴がある要求でも422にしていた。

公式テスト: [Responses headers](https://github.com/openai/codex/blob/main/codex-rs/codex-api/tests/clients.rs)、[cache affinityと分岐会話](https://github.com/openai/codex/blob/main/codex-rs/core/tests/suite/prompt_cache_key.rs)。依存ライブラリの追加は不要で、既存のID解決とcheckpoint完全一致検証を使う。

解決順序は`thread-id` → 本文の`thread_id` → turn metadataの`session_id` → 旧`session_id`ヘッダー → `session-id`ヘッダー → 本文の`session_id` → `prompt_cache_key`。UUIDのみを受け付け、turn metadataは8KiB以内で構文を検証する。選ばれたIDのログが一致しない場合、他のチャットやcache IDへ自動で探索を広げない。

`router_request.history_identity_source`にはID解決元の固定分類だけ、`history_restore_reason`には`invalid_thread_id`、`invalid_checkpoint`、`log_not_found`、`ambiguous_log`、`unsafe_log`、`checkpoint_not_found`、`rollback_detected`、`metadata_mismatch`、`invalid_log`だけを記録する。ID値、パス、本文、暗号化履歴、認証情報、パーサーの例外文は記録しない。旧ログの`OtherError`のみでは既存障害の個別原因は確定できない。

検証: 現行形式のIDと異なるcache keyを送る2回帰テストは修正前に失敗、修正後に成功。Python 3.11をPATH先頭にした`python3 scripts/run_test_inventory.py`はNode423件・Python186件、全609件成功。実APIへの追加送信、稼働サービスの再起動、既存会話の変更は行っていない。

## 確認した問題

該当するユーザーチャットのtask_completeに `compaction_handoff_failed (HTTP 502)` と同じエラーが残っていた。中継は上流のresponse.failed/errorをすべて同じ文へ変換していたため、元の失敗コードを後から確認できない。初回実障害が一時的なserver_errorだったとは確定していない。

## 修正

- エラーの固定許可リストを使い、原因コード・HTTP状態・段階・試行回数を表示/記録する。上流のmessageや未知のコード文字列は出力しない。
- 明示的なserver_error/rate_limit_exceeded、HTTP408/500/502/503/504に限り、同じ入力で1秒後に1回だけ再試行する（合計最大2試行）。
- 認証エラー、入力や暗号化の不正、不明コード、HTTP429は再試行しない。
- 要約が完成した場合だけcacheする。同時要求の共有と、全待機者のキャンセルによる停止は維持する。
- 元の会話・指示・進行中のツールは保持する。OpenCodeへ未変換の暗号化を送って継続したことにはしない。

公式の失敗イベント仕様: https://developers.openai.com/api/reference/resources/responses/streaming-events

## 検証

- 修正前は、新規4試験（一時復帰、安全な原因表示、2試行上限、再試行待機キャンセル）が失敗。修正後は成功。
- Node124 / Python81、全205ケース成功。全件は `docs/test-inventory.md`。
- 既存4試験の503要求回数期待値は、仕様変更に合わせ1回→2回へ更新。永続的な失敗や不明コードの期待値は1回を維持。
- `MOCK_HANDOFF_TRANSIENT=1 python3 test/handoff-app-e2e.py`: 実Codex app-serverで暗号化圧縮→一時要約失敗→2回目で成功→OpenCode回答→cache→resume成功。
- `python3 test/handoff-app-e2e.py --fail`: 実app-serverで連続失敗は2試行で停止、OpenCodeへの要求なし。
- shell構文、Pythonコンパイル、git diff --check成功。
- 実API追加0要求、顧客履歴の代理再送なし。上流は模擬API。元の実障害原因・実スレッドの再開成功は未確認。

## EHOSTUNREACH追補（Issue #110）

2026-10-26T00:26:19Zのセッション `01a17198-6f32-7d90-8a12-9ffd73bfec6a` で、HTTP応答前の `TypeError`（`cause.code=EHOSTUNREACH`）が既存の接続回復対象外となり、`summary_attempts=1` で停止した。従来の判定は `ETIMEDOUT` と `UND_ERR_CONNECT_TIMEOUT` だけを対象にしていた。

固定許可リストへ `EHOSTUNREACH`、`ENETUNREACH`、`ENETDOWN`、`EHOSTDOWN`、`ECONNREFUSED`、`ECONNRESET`、`ECONNABORTED`、`EAI_AGAIN`、`UND_ERR_HEADERS_TIMEOUT` を追加した。直接cause、トップレベルcode、AggregateError内の固定コードを対象にする。HTTP応答前だけを対象とし、既存の合計最大2試行、成功時のみcache、取消・未知コード・HTTP応答後失敗の非再試行は変更しない。直接 `EHOSTUNREACH` の回帰テストは修正前に失敗し、修正後に成功した。
