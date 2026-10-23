# Codex AppとCLIで履歴引き継ぎの待機状態を表示する

通常のGPT利用ではOpenAI標準の履歴圧縮を使い、同じ会話の`/model`からOpenCodeへ切り替えたとき、読めない圧縮履歴だけを既存のGPT接続で文章要約へ変換する。全文の復号ではなく、省略のあり得る引き継ぎ要約である。

## 表示

要約の新規作成または同時要求の要約待ちが1秒以上続いたとき、bridge生成のcommentaryを送る。

> 接続ステータス：圧縮された会話履歴を、選択中のモデルで使える形式に変換しています。

要約が完成したら次を続け、その後にモデルの回答・ツール呼び出しを通常どおり流す。

> 履歴の変換が完了しました。選択中のモデルの応答を待っています。

これはモデルが生成した思考ではなく、接続処理の状態表示。Codex AppとCLIが共通で使うapp-serverの`item/agentMessage/delta`へ届く。Appの会話欄に表示するための通常のcommentary形式であり、専用のバナーやApp本体の変更ではない。

入力予算を超えて履歴を追加要約するときは、モデルを切り替えていなくても次を表示する。

> 接続ステータス：入力上限に収まるよう、会話履歴を要約しています。

完了時は「履歴の要約が完了しました。選択中のモデルの応答を待っています。」と表示する。OpenCode間のモデル変更だけではキャッシュは無効にならない。

## ツールの反復を停止する

OpenCode経路では、同じツール入力と同じ完了結果が3回続いたとき、そのターンの次の要求を「ツール無しで取得済みの結果から回答する」要求へ変更する。以前の一律6回でHTTP422を返す方式は廃止した。呼び出しID・引数・結果と既存指示は保持する。

`pending/running/queued/in_progress`の状態結果、`wait/write_stdin/sleep`、実行中セッションを返す結果は同一結果反復として数えない。結果が変わる観測も同一結果反復ではない。そのため意図的なポーリングを6回だけで止めない。ただし、任意の文章だけから利用者の意図を完全には判定できない。

ツール名・引数・結果を変え続ける場合も無限継続しないよう、1つのユーザー発言に対して完了したツール一式が64回になったら回答へ戻す。並列ツール一式は1回、新しいユーザー発言でリセット。これは長い正常タスクにも作用し得る有限予算で、意味的な「無進捗」を完全に判定するものではない。未完了呼び出し・最新ユーザー境界がない履歴は判定しない。

回答復帰ではtoolsを空にしtool_choice=none、既定出力上限8192 tokenを指定する（明示された小さい上限は保持）。回答だけがlengthで途切れた場合、上限の余地があれば最大16384 tokenで1回だけ再生成する。再生成でもtools=[]/noneと同一履歴を保持し、最初の途中回答は配送しない。失敗・無効ツール・content_filterは無制限再試行せず停止する。上流がこれを無視してツールを返しても、回答復帰専用の検証でツール項目を配送せず、非再試行エラーで止める。成功や未完了を偽らず、取得済みの結果を回答するよう指示する。

## Chat変換の正常性

`src/chat-protocol.mjs`をrepoと稼働legacyブリッジで共有する。正常なfinish_reason（stop/tool_calls）、ツールID、JSON引数を検証し、出力上限length、filter、終端欠落、壊れたJSONはツール実行前に失敗させる。ツール付き説明はcommentary、最終回答はfinal_answerとして返す。入力では説明・思考・ツールを1つのassistant messageにまとめ、同じ完了済み思考項目の重複連結を除く。

旧変換の終端見落としと重複思考連結は再現済み。ただし元の長い会話でモデルが反復を選んだ全原因を特定した、という意味ではない。すべてのモデル・会話で反復しなくなる保証はできない。

検証は`node --test test/*.test.mjs`、`python3 test/chat-bridge-app-e2e.py`。実モデル試験は明示的に`RUN_LIVE_MODELS=1 node test/live-tool-recovery.mjs`を実行し、ローカル共通router経由で合成入力のみ、GLM/HY4に最大4要求・各1024 token・60秒で試す。通常CIでは実APIを呼ばない。

legacy適用は`python3 scripts/install_chat_protocol_service.py --update-now`、router適用は既存の`install_router_service.py`。ソースとhelperをバックアップし、起動確認失敗時に復元する。Appや会話ファイルは変更しない。

## 表示しない場合

- 同じ会話・認証・圧縮内容の要約キャッシュがhitした場合。
- GPTの通常要求、または要約不要なOpenCode要求。
- 1秒以内に要約が終わった場合。
- `stream=false`の要求。

キャッシュはrouterのメモリ内のみ。初回だけ永久に要約するという意味ではなく、router再起動・認証や圧縮内容の変更・キャッシュ退避後は再要約する。要約に必要なGPTの利用枠と待ち時間が発生する。

## 履歴と失敗の扱い

待機表示は`msg_bridge_handoff_`で始まる専用ID、assistant role、commentary phaseを持つ。次の上流要求と引き継ぎ要約からこの専用表示だけを除外する。普通のcommentary、ユーザー依頼、ツール結果は保持し、会話ファイルは編集しない。

待機表示を出した後はHTTPヘッダーを変更できないため、後続の失敗を`response.failed`で返す。要約失敗を完了回答として扱わず、不完全な履歴をOpenCodeへ送らない。変換失敗や入力不正は非再試行エラーとして返し、同じ要約を自動的に何度も呼ばない。上流429はrate-limitとして区別する。

ステータスを先に出すストリームに限り、response ID・output index・sequenceを整合させ、最終outputにも表示項目を含める。要約が速く表示しなかった要求は従来のレスポンスを維持する。通信の本文・認証・要約内容をログへ記録しない。

## 設定と適用

本スレッドで先に有効にした全体の`remote_compaction="unsupported"`設定は、本人のバックアップと現設定を比較したうえで戻す。新規の通常起動は組み込み`openai` providerを使い、`openai_base_url`の共通router接続は維持する。GPT専用と切替用の起動分離は不要。

既存のcustom provider会話の保存設定は自動書換えしない。設定の読込みにはCodexの再起動が必要な場合がある。既存OpenAI会話でも共通routerを使っていれば、必要時の引き継ぎ処理を使える。

router更新は次の既存コマンドで、接続が空くまで待って行う。

```bash
python3 scripts/install_router_service.py --update-if-idle --wait-idle 900
```

本人が通信中断を承知で今すぐ更新する場合だけ、`--update-if-idle --wait-idle 900`の代わりに`--update-now`を明示する。両モードは同時に指定できない。

Codex AppやCLIを強制終了しない。更新を待機させた場合は、更新完了ログとhealthのrevision一致を確認するまで反映済みとは扱わない。

## 検証

```bash
node --test test/handoff-status.test.mjs
python3 test/handoff-app-e2e.py
python3 test/handoff-app-e2e.py --fail
```

実Codex＋偽認証＋模擬上流で、native remote compactionからの切替、App共通の待機/完了通知、cache hit、再起動resume、失敗時の停止、認証分離、表示文の上流非送信を確認する。単体では分割UTF-8 SSE、JSON上流、ツール変換、429、タイムアウト、キャンセル、同時要求も検証する。

App共通プロトコルの検証であり、実Appの描画スクリーンショットと実モデルによる要約品質は別検証。画像413の入力見積もり修正は含めない。

## 処理別の表示と上流エラー診断

入力上限に収める処理は「入力上限に収まるよう、会話履歴を要約しています」と表示する。同じ処理を共有する要求には「別の要求で進行中の同じ履歴処理の完了を待っています」を添える。モデル切替の有無ではなく、実際の履歴処理で表示する。キャッシュヒット時は表示しない。

ステータス開始後の上流エラーは最大16KiB・1秒で読み、許可済みcode/typeと固定の理由分類だけをSSEのresponse.failedとrouterメトリクスに残す。生のmessage、未知のcode/type、会話本文・認証情報は残さない。messageだけに理由がある場合も固定分類（画像・コンテキスト長・ツール履歴）のみ出力する。取得不能はunknown_errorと読取状態を記録する。これは診断改善であり、上流400自体の修復や自動再試行ではない。

OpenCode Chat向けの画像入力では、Codexの`detail: original`を`high`へ変換する。OpenCodeが受け付ける画像detailはauto/low/high。ユーザー画像とツール結果画像の両方に適用し、既存スレッドを編集せず送信時に変換する。画像のバイト列は変更しない。

回答復帰時の空文字・空白だけの回答・reasoningのみの応答は`empty_output`で区別する。上限を維持し、同じ履歴・モデル・tools=[]/noneで1回だけ再生成する。lengthと空応答の再生成予算は合計1回であり、2回目の失敗を正常完了と偽らない。回復メトリクスに終端状態と理由を保存する。利用者の`interrupted`は空応答と区別し、自動的に作業を再開しない。

空の回答に出力上限の付帯情報もある場合はempty_outputを優先し、利用者の小さい上限を超えずに再生成する。再生成先の接続障害に対してavailability再試行を入れ子にしない。追加生成の要求は最大1回で、再度の失敗は記録して停止する。

## 履歴要約の未完了からの回復

履歴要約では、空の要約・SSE終端の欠落・出力上限による未完了を区別し、既存の一時障害と合計して最大2回の生成で回復を試みる。要約専用の出力予算は8192 tokens、出力上限で未完了だった場合のみ2回目を16384 tokensにする。元の指示・最新の依頼・実行中のツール交換は保持し、要約生成のtoolsは空にする。

正常完了した文章だけをキャッシュ・転送する。拒否、不正形式、ツール実行項目、64KiBを超える要約は転送せず停止する。再試行も失敗した場合は元の履歴を保持して理由を表示する。要約の意味的な完全性や上流サービスの無障害を保証するものではない。

ログには固定の`summary_error_code`、`summary_response_status`、`summary_output_limit`、`summary_output_bytes`と試行回数を記録し、要約本文や未知のエラー理由は記録しない。

```bash
MOCK_HANDOFF_RESULT=incomplete python3 test/handoff-app-e2e.py
MOCK_HANDOFF_RESULT=empty python3 test/handoff-app-e2e.py
```

## 画像を含む大きな履歴

受信した本文と圧縮展開後の本文には128MiB、変換後のモデルへの送信と上流応答には32MiBの上限を設ける。`/health`の`request_limits`で稼働値を確認できる。上流への要約生成に渡す過去履歴は受信上限内で扱い、要約結果は従来どおり64KiB以内とする。

OpenCode Chatへの送信が32MiBを超える場合は、token見積もりが小さくても既存の安全な履歴境界を使って要約する。圧縮履歴がある場合も必要に応じて完了済みの画像ツールまで要約範囲を広げ、二重要約を避ける。最新の依頼、指示、未完了のツール交換を保持する。

受信上限超過、保護する内容だけで送信上限超過、要約失敗、自動要約の無効化では停止する。通常GPT経路と明示的な直接Responses経路では、この容量回復による要約を行わない。容量制限そのものを撤廃したり、最新画像を黙って削除したりする処理ではない。

診断には`received_bytes`、`decoded_bytes`、`budget_initial_bytes`と、拒否した制限の固定分類`input_limit_reason`（wire_bytes / decoded_bytes / forwarded_bytes）を使う。会話本文や画像データは記録しない。

## 完了イベントに本文が再掲されない要約応答

native SSEでは`response.output_item.done`に完成した文章が届いても、最後の`response.completed.response.output`が空の場合がある。終端だけを見て`empty_summary`と判定せず、正常完了した応答に限り、完了済み項目をindex順に復元する。上限128項目で、indexの欠落・重複、不正形式、拒否、ツール実行項目を拒否する。

終端に非空のoutputがある場合は、それを正本として採用し、ストリーム項目と二重に連結しない。deltaや進行中メッセージは要約に使わず、終端欠落・failed・incompleteからは復元しない。推論本文は転送しない。

`summary_output_source`（terminal / completed_items）と`summary_completed_items`を記録する。本文のログは残さない。

```bash
MOCK_HANDOFF_THIN=1 python3 test/handoff-app-e2e.py
```

## 要約先への接続タイムアウト

HTTP応答を受け取る前の`ETIMEDOUT` / `UND_ERR_CONNECT_TIMEOUT`は`summary_connect_timeout`に分類し、既存の合計最大2回の要約要求予算で一度だけ再試行する。複数アドレスへの接続失敗をまとめたエラーも最大16件の固定コードだけを調べる。

HTTP応答後の読取失敗、未知の通信エラー、親timeout、利用者による中断はこの再試行の対象にしない。HTTP応答がない場合は架空のHTTP statusを付けず、再失敗時は元の履歴を保持して停止する。接続先のアドレスや生のエラー本文はログへ残さない。ネットワーク自体の障害を解決する機能ではない。

```bash
MOCK_HANDOFF_CONNECT_TIMEOUT=1 python3 test/handoff-app-e2e.py
```
