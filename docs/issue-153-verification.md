# Issue #153: 既存OpenCode会話の圧縮とツール互換性

## 原因と修正

- 既存会話は起動時のremote compaction方式を保持する。共通設定が文章圧縮でも、旧会話の要求はOpenAI固有形式のまま到着し、selectedモードが422で拒否していた。既存形式の圧縮要求だけをnative要約モデルで処理する。askは停止を維持し、通常応答のモデル選択は変更しない。
- 元ログ復元は64MiBの一括読み込み制限があり、約151MB・105MBの実ログを拒否していた。固定サイズsnapshotを逐次走査し、512MiB scan・32MiB/行・128MiB復元内容の上限と所有者・権限・リンク・分岐・rollback検査を維持する。
- 復元内容も約87MB・45MBあるため、8MiB超は全tool出力を分割再送せず、要求内のnative checkpointをOpenAIで文章化する。元ログ自体は外部へ送らない。小さな通常履歴は選択モデルで要約する。
- 実APIのnative remote compactはContent-Typeを省略したSSEを返す場合がある。要求のstream属性に従って補完し、JSONとして誤解析してsocketを閉じない。
- 旧8788の更新処理は `upstream = doFetch(...)` だけに対応し、実配備の `attempt = doFetch(..., auth, signal, session)` を更新していなかった。末尾引数を保持して正規化を適用する。toolsなし回答復帰からもtool_choiceを除去する。

## 検証

- Node全回帰383件、Python186件が合格。その後追加した旧compact endpoint・Content-Type省略SSEを含む関連router/historyテストも合格。
- 実際の既存ログ2件をread-onlyで復元。本文を出力せず、模擬上流でnative checkpoint→OpenCodeの継続が両方HTTP 200。上流へ渡す元checkpoint要求は約40KBで、復元した巨大tool出力は送信されない。
- 実OpenCodeを直接指定し、自動フォールバックなしでtool call→tool result→応答、および空tools/auto要求が成功。
- 検証専用の正式Codex app-server会話でOpenCode応答→remote compaction→同じ会話の続行がcompleted。続行時も検証マーカーを保持した。
- 対象の実paneには指示を送信しない。図解係・pptx係の本作業再開と要約内容の確認は本人が行う。

## 反映と差し戻し

変更前の設定・対象コード・plistを本人専用バックアップへ退避し、38ファイルのSHA256を照合した。共通config.tomlと履歴モードファイルは既に文章圧縮/selectedのため変更していない。既存の稼働routerだけに存在する認証・カタログ修正は保持して差分を適用する。8788は管理installer、8791は本人の短時間再起動承認後に管理installerで更新する。

本人専用バックアップのROLLBACK.mdとrollback-services.pyに、接続がないときに旧コード/helper/plist/runtimeを復元する手順を保存する。会話DBや元rolloutの直接上書きは行わない。秘密値と会話本文はGit・Issueへ保存しない。

native形式の互換処理にはOpenAI認証・利用枠・上流の可用性が必要であり、将来の全エラーがなくなる保証はしない。ログ上限を超える場合や履歴が分岐・欠落している場合は引き続き安全に停止する。
