# BridgeでCodexのツール検索とusageを保持する

Issue #118。既存のCodexハーネス・認証・接続先を維持するための通信互換性修正です。
CPU前処理の改善（#116 / PR #117）とは別の変更です。

## 直した問題

以前のChat変換はfunction以外のtoolを除外し、Codexのclient-executed `tool_search`を失っていました。
検索のcall/output履歴や、名前空間を持つ追加ツールも通常のChat形式へ変換できていませんでした。
修正版は要求ごとの対応表を作り、client検索をChatの関数として送信し、返答を本来の
`tool_search_call`（object型arguments、execution=client、元call_id）へ復元します。
検索結果で読み込んだ関数だけを追加し、namespaceとcustom toolの入力形式も往復します。

- 通常のtools配列、Responses Liteのadditional_tools入力itemを扱います。
- 未ロードのdeferred定義を勝手に公開しません。completedな検索結果だけを使います。
- 関数の強制指定もChat用の対応名へ変換します。
- 検索結果には元の名前とChatで呼べる名前の対応を示し、保存会話は変更しません。
- 不正/未知/未ロードの呼び出しは実行可能な出力として返しません。
- hosted（execution=server）検索をローカル検索で代用せず、未対応形式は422等で明示停止します。
- 本文、ツール引数、資格情報を新たにログへ保存せず、全体のschema共有cacheも追加しません。

Chat応答のusageは共通mapperでinput/output/totalに加えcached_tokensとreasoning_tokensを保持します。
欠落したinput/outputを0へ置き換えません。totalだけ欠けた場合は既知input+outputで導出します。
不正な数値や矛盾した内訳はusageのみを省略し、正常な回答を止めません。
`include_usage`は既存どおり有効です。APIが返さない数値は復元できず、独自要約を含む全消費集計や請求額計算は別です。

## 模擬E2Eと再現条件

```sh
node --test test/tool-search.test.mjs test/usage.test.mjs
python3 test/codex-tool-search-e2e.py
python3 test/codex-tool-search-e2e.py --lite
python3 test/codex-tool-search-e2e.py --code-mode
python3 test/codex-tool-search-e2e.py --lite --code-mode
```

実際のCodex実行ファイルに、129個の合成MCPツールを持つローカルサーバーと模擬上流を接続します。
検索→対象1個のschema取得→MCP実行→実結果の回答まで確認します。
HOME/CODEX_HOMEと環境を隔離し、本人の認証・本物のMCP接続・外部推論APIを使いません。
旧masterでは同じfixtureがMCP未実行で失敗し、修正版では成功しました。

通常/Liteはtool_mode=null、supports_search_tool=trueを使う専用client検索の試験です。
Code Mode試験は隔離環境だけでcode_mode_tool_search=trueを指定します。
普段のfeature、モデル選択、model catalogは変更していません。
単独カタログでsupports_search_tool=falseのままなら、この修正だけで検索が自動的に有効にはなりません。
採用するモデルカタログ・Code Mode設定と、実際の上流形式を反映時に確認してください。

数値例として通常経路では初回約19KBのChat tool定義で開始し、検索後に対象1個分だけ増えました。
これは合成fixtureの結果で、以前の実ログ1.46MBからの削減率ではありません。
全てのCodex組込み説明やgrammarを削減する変更でもなく、実モデルの速度改善率は未測定です。

## 配置と戻し方

routerの固定runtimeコピー・実装hashにはtool-search.mjsとusage.mjsを追加しています。
legacy backend用patch_chat_protocol.pyも、3helperを一括検証・配置・manifest管理します。
旧manifestからの移行、管理外変更・symlinkの拒否、部分失敗時のrollbackをテストします。
通常のサービス更新はinstall_chat_protocol_service.pyのアイドル確認・復元手順に従います。

今回の作業では本番ファイルの更新、サービス起動/再起動、既存会話の書換えを行っていません。
現runtimeには先行する未マージ修正もあるため、masterベースの本ブランチを丸ごと上書きしてはいけません。
人間承認後、先行修正を保持した統合候補で再検証してから反映します。

## 契約の根拠

- [Codex 0.164.0のtool dispatch](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/tools/router.rs)
- [Codexの検索結果item生成](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/tools/context.rs)
- [公式client tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)
- 回帰テスト: test/tool-search.test.mjs、test/usage.test.mjs、test/test_patch_chat_protocol.py、test/test_install_chat_protocol_service.py。
