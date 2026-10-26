# 過去のツール定義による422の修正

GPTで使っていた会話をChat経路のモデルへ引き継ぐと、過去のツール定義と現在の定義を同じ登録として比較し、説明やschemaの変更だけで422を返していた。履歴の要約後も`additional_tools`が保持されるため、要約だけではこの衝突を解消できない。

現在の`body.tools`と`body.additional_tools`を優先し、過去の宣言と完了したclient検索結果は時系列のsnapshotとして扱う。検索結果だけから発見した関数は従来どおり読み込める。過去の宣言全文を新しいChatメッセージへ複製せず、元の履歴オブジェクトも変更しない。

完了済みserver検索は、`call_id:null`を含めて非実行の履歴データとして保持する。現在要求されたserver検索をclient関数へ置き換えることはしない。同じ要求内の矛盾した定義、未知・未ロードの呼び出し、不正な引数は引き続き拒否する。

圧縮境界はclient検索の呼び出しと結果を分断しない。customツールの履歴と強制選択ではnamespaceを保持する。これにより、モデル切替後も同じ名前空間の識別を維持する。

変換に失敗した場合は、`conflicting_current_definitions`、`unsupported_live_search`等の固定コードだけを返す。履歴準備後のエラー表示でもコードを残す。例外本文、会話、認証、ツール説明は診断へ出さない。既存の管理済みbackendも更新スクリプトで同じ分類へ移行できる。

検証は次のとおり。

- 合成データで、現在と過去の説明/schema差、server検索履歴、ペア境界、namespace、安全な診断分類を再現。
- 実Codexの同じ会話を2回実行し、検索済みツールをV1から必須引数付きV2へ更新。旧版は2回目の検索後に422、修正版は6要求・2ツール実行で完了。
- 通常／Lite／Code Mode／両方の各経路で、新規会話と履歴更新の計8モードを検証。実APIや本人認証は使用しない。

```sh
python3 test/codex-tool-search-e2e.py --history-evolution
python3 test/codex-tool-search-e2e.py --history-evolution --lite
python3 test/codex-tool-search-e2e.py --history-evolution --code-mode
python3 test/codex-tool-search-e2e.py --history-evolution --lite --code-mode
```

本人の保存履歴については本文を出力せず、ローカルの読み取りだけで型と変換を照合した。保存履歴と新規CLIで取得した定義の組合せは旧版でも受理され、失敗時のTUI要求と完全には一致しない。したがって、同じ422を起こす互換性の欠落は再現・修正できたが、実際の拒否条件の断定と本人画面での成功確認は別に扱う。実会話の再送・書換え・削除は行わない。

追加で、同じSDK harnessの現在の保存済みツール定義と対象の実履歴を組み合わせた。4 namespace・13ツールのidentityは全件一致し、説明文だけが1件異なっていた。旧版は重複定義の比較で拒否し、修正版は同じ組合せを480件のChatメッセージへ変換できた。これは単純な新規CLIより実環境に近い再現だが、失敗したTUI要求そのものからの採取とは区別する。本番では合成履歴を使い、backend直接3要求とrouter経由1要求のすべてで実DeepSeekから正常な応答を確認した。

関連: [Issue #122](https://github.com/nanameru/codex-bridge/issues/122)
