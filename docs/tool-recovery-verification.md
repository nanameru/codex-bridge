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
