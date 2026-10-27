# 圧縮送信失敗の診断記録（Issue #134）

## 分かったことと未確定のこと

対象会話では、2026-10-27 20:01:05 AEDTに自動圧縮を開始し、約30秒後に
`stream disconnected before completion: error sending request` で失敗した。
直前の通常要求はHTTP 200だった。既存のルーター記録には、この圧縮要求と
対応付けられる終了記録がなく、起動メッセージにも時刻がなかった。
このため、要求の未到達・上流接続の切断・プロセス再起動を区別できない。

ディスク空き容量不足は別途観測したが、通信切断との因果関係は未確認。
Nodeのconsole.logへのENOSPC注入試験ではプロセスは終了しなかったため、
「ログ保存失敗でプロセスが落ちた」という仮説は採用しない。

## 変更

CLIで起動したルーターは標準出力へJSONの診断イベントを記録する。
LaunchAgentでは従来のStandardOutPathに保存される。

- `router_request_started`: 認証成功後、本文の受信を開始する段階。
- `router_request_decoded`: JSON解析と入力形式確認が完了。`compaction_trigger`も判別する。
- `router_request_upstream`: 履歴準備の開始、または最終転送の直前。`stage`で区別する。
- `router_request_headers`: 最終転送と既存の提供元切替処理の後、応答ヘッダーを確認できた段階。
- `router_request_finished`: 完了・拒否・切断・deadline到達。最後の`stage`と安全なエラーコードを記録する。
- `router_started`, `router_stopping`, `router_fatal`, `router_exit`: 起動、SIGTERM/SIGINT、未捕捉例外の監視、終了。

全イベントにUTC時刻、PID、起動ごとのIDを付ける。要求イベントは同じrequest_idを使う。
既存の終了メトリクスにも時刻とプロセスIDを付ける。
スレッド参照は起動ごとに生成する非保存の鍵でHMAC化する。
本文、指示、ツール定義、認証ヘッダー、エラーメッセージ・スタック、転送先URLは
新しい診断イベントへ保存しない。記録失敗は推論やHTTP応答を変更しない。

## 次回の調べ方

1. Codexの失敗時刻付近の`router_request_started`を探す。
2. `request_id`で後続イベントを対応付け、最終stageと`termination_reason`を確認する。
3. 同じ`process_instance`の停止・fatal・exitを確認する。次の起動IDへ変化していれば再起動の範囲を絞れる。
4. 開始記録がない場合は、Codex側の送信・接続先・認証段階と、ルーターの稼働期間を照合する。

終了記録がないだけではクラッシュと断定しない。SIGKILL・OS障害・ログ書込不能では
終了イベント自体が残らない。上流内部の状態やCodex側の接続前の失敗もこのログだけでは分からない。

## 検証と反映状況

`test/router-diagnostics.test.mjs`で遅延応答・接続失敗・deadline・ストリーム切断・
診断データの許可リスト・起動ごとの匿名化・例外監視の挙動を検証する。
本変更は診断情報の欠落を修正する。通信切断の根本原因を修正したとは扱わない。
本番再起動、対象会話の再開、履歴編集はこの変更に含めない。
