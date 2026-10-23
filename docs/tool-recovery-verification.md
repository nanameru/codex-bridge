# ツール反復対策の検証記録（Issue #51）

2026-10-23。比較元は #50 の `4be6c27`。

## 再現して修正した変換欠陥

- Chatのfinish_reasonを確認せずEOFだけで完了扱いしていた。実Codex app-server→実Chat bridge→模擬APIでlength打切り時にツール1回実行・turn完了になることを修正前に再現。修正後はツール0回でfailed。
- Responses側で説明とツールに付く同一reasoning itemを、旧Chat変換が同じassistant messageへ2回連結していた。旧稼働ソースを使った合成入力で再現し、新変換では1回になる回帰テストを追加。
- 元の長い実会話の反復が、この2点だけで生じたという因果関係までは確認していない。

## 修正後の検証

- Node104件・Python81件、GitHub Actions switch-tests成功。
- 実app-server＋実Chat bridge＋模擬API: 通常ツール1回→回答、同一完了結果3回→ツール無し回答、pendingポーリング8回継続、引数変更は試験用10回予算で回答復帰、打切り0回。計27要求。既定の有限予算64回は別の回帰テストで確認。
- GPT↔OpenCodeツール往復・resume（8ターン16要求）・履歴引き継ぎも成功。
- 稼働legacyソースの一時コピーへのパッチ、認証分離・call_id・ツール結果転送を確認。

## 実API（合成入力のみ）

- 適用前: GLM5.3 Flash / HY4 Previewを直Chat・旧ブリッジで比較。各ツール1回→回答、計8要求成功。短い入力では元の反復は再現しなかった。
- 適用後: 稼働共通router経由の `RUN_LIVE_MODELS=1 node test/live-tool-recovery.mjs`。GLM通常ツール1回→回答2要求、GLM反復履歴→回答1要求、HY4反復履歴→回答1要求、すべて成功。ツールは合成結果を返すだけで外部操作しない。
- 実推論は合計12要求。元の顧客会話やツール定義一式は送っていない。認証や思考本文は記録しない。

## 反映

Chat bridge revision: `a58fc4aaff685c931a8725a9f66ee9b66d1d39f55a5f964ef3b007015da9c76d`

router revision: `3066372327da9296d249a0cff80711889196d92d3a61224551fff6e64e312534`

両サービスの稼働revisionと認証拒否401を照合。App本体・会話ファイルは変更しない。PRはDraft・未マージ。

## 限界

自然文だけから意図的ポーリングを完全には識別できない。64回予算は長い正常な作業にも作用し得るが、HTTP422で打ち切らず取得済み結果と未完了事項を回答する。全モデル・全会話の無再発保証はしない。

## 追加監査（2026-10-23、0de8639）

- 異常系8ケースのうち修正前7件失敗→修正後全件成功。全オフライン193件（Node112 / Python81）成功。全件は `docs/test-inventory.md`、生結果はCIの `case-results` artifact。
- 実app-server＋実Chat bridge27要求、実app-server＋模擬Responses8要求、稼働legacyコピーのtransport試験を追加修正後に再実行して成功。
- 旧securityパッチの再適用が追加importだけで誤拒否される不具合も修正。保護欠落・管理外helper改変の拒否は保持。
- 追加反映後の実API4要求: GLM通常2要求と反復回復1要求は成功。HY4はcompleted・ツール無しだが期待文字列BUILD_OK_42を含まないため、結果照合の検証は**失敗**。初回失敗時の回答本文は保存しておらず、意味が同じだったかは確定できない。
- 原因切り分けのため追加1要求だけHY4へ同じ合成履歴を送り、completed・ツール無し・BUILD_OK_42を含む回答を確認。再試験成功で初回失敗は取り消さない。元会話のループは再現していない。
- 今回は計5実API要求、前回までの12要求と合わせ17要求。全モデルの結果照合成功や回答の決定性は未確認。実APIを無制限に再試行しない。

最新Chat bridge revision: `dd46eb9237d6b37f56796f359cd31e0ac05bbd88ec08359d9bc72cfe62bdf314`

最新router revision: `9af7e74a2aaed38af0e2003f5db70d3ff340f69a09a347ab1147a04d038cd572`

両稼働revisionと401を再照合。CI成功、Draft PR #52は未マージ。HY4の初回結果照合失敗は未解明としてIssueに残す。
