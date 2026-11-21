# 履歴の引き継ぎモード

外部モデルで会話しているときの補助要約を、利用者が選べます。未設定時は `selected` です。設定は本人の `CODEX_HOME/bridge-history-mode.json` に保存し、対応版routerでは次の要求から読み込みます。会話・認証・モデル選択は書き換えません。

| モード | 動作 |
| --- | --- |
| `selected`（既定） | 元ログから復元できる履歴を選択中のモデルで再要約する。入力上限に対する追加要約も同じモデルを使う。既存会話のremote compactはOpenAIの正式形式を使う。復元内容が8MiBを超える場合もOpenAIでcheckpointを読み取り、その後は選択モデルへ戻る。 |
| `openai` | 従来通り、暗号化履歴の引き継ぎや追加要約にOpenAIを使う。OpenAIへ会話を送信し、利用枠を消費する。枠を使い切っていると失敗する場合がある。 |
| `ask` | 補助要約が必要になると送信前に停止し、選択方法を表示する。Codex本体へ対話ダイアログを追加する機能ではない。明示的にモードを変更して再試行する。 |

Bridgeリポジトリで実行します。

```sh
# 現在のモードと注意書きを表示
node src/history-mode.mjs

# 選択中のモデルで引き継ぐ
node src/history-mode.mjs --mode selected

# 必要に応じて切り替える
node src/history-mode.mjs --mode openai
node src/history-mode.mjs --mode ask
```

設定は同じ `CODEX_HOME` のrouterを通る会話に共通です。一度 `openai` を選ぶと、`selected` や `ask` へ戻すまでその設定が続きます。新しいコード自体の導入にはrouterの更新が必要ですが、導入後のモード変更に再起動は不要です。Codex公式へ直接接続する会話には適用されません。

## 選択モデル方式の注意書き

> 保存された会話ログを選択中のモデルで要約し直します。既存会話のremote compactと8MiB超の履歴のcheckpoint読み取りはOpenAIを使用します。通常の文章履歴の再要約は選択モデルを使用しますが、元ログの不足や再要約により、過去の指示・判断・細部が引き継がれない場合があります。選択モデルの要約分の利用量は発生します。

この案内はCLIのモード表示と、実際に引き継ぎ・追加要約を行った際のBridgeの案内に表示します。Bridgeの案内は次のモデル入力へ再送しません。

OpenAIの**文章の要約**は他のモデルでも読めます。DeepSeekの精度が必ず低下するという意味ではありません。OpenAIの**暗号化された圧縮item**をDeepSeekが読むことはできず、元ログからの再構成は暗号の解読でも完全な復元でもありません。隠れたreasoningは移行しません。

## 元ログから引き継げる条件

- 本人の `CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<会話ID>.jsonl` に原本が1つだけ存在する。
- 要求の会話IDとログの `session_meta.id` が一致し、同じ暗号化checkpointを特定できる。
- 先頭から読める会話記録があり、分岐・巻き戻し・不正JSON等の不確実な状態ではない。
- 所有者・安全な権限を確認できる通常ファイルである。symlink/hardlink、512MiBを超えるログ、32MiBを超える行、128MiBを超える復元内容、探索上限を超える配置、アーカイブのみの会話には対応しない。

子会話だけで作った暗号化checkpointも、分岐元の履歴が完全か確認できないため、この元ログ復元の対象外です。条件を満たさなければ、外部へ送信する前に理由を表示して停止します。原本はread-onlyで扱い、成功した文章要約のみを会話・認証・モデル別に上限付きのメモリ内キャッシュへ保存します。キャッシュは再起動や追い出しで消えるため、再要約が必要になる場合があります。

## Codex標準の文章圧縮との組み合わせ

新規会話は次をプレビューしてから適用すると、選択モデルによるCodex標準の文章圧縮を使えます。

```sh
python3 scripts/portable_history.py
python3 scripts/portable_history.py --apply
```

すでにOpenAI固有のremote compactionを使う会話では、`selected`でもその圧縮要求だけをOpenAIの要約モデルへ送ります。`compaction_trigger`と従来の`/responses/compact`の両方が対象です。会話のモデル選択と次の通常応答は変えません。OpenAIへの送信・利用量が発生し、認証・枠・上流の可用性が必要です。`ask`は引き続き送信前に停止します。新規会話の文章圧縮は選択モデルのままです。

### OpenAIが利用上限のとき（Issue #186）

OpenAI以外のモデルを選んでいて、remote compaction（`compaction_trigger`付きの要求と`/responses/compact`）でOpenAIの要約モデルが429（利用上限）を返した場合は、選択中のモデルが代わりに要約します。自動のDeepSeek V4.1 Flashでは、同じモデルの設定済み提供元（OpenCode Go → Command Code → Ollama）を順に試します。`selected`と`openai`の両方が対象で、`ask`は従来どおり送信前に停止します。GPTを選んでいる会話の動きは変わりません。

- 要約結果は、Bridgeだけが読める印（`cxbsel1:`）を付けた圧縮項目1件としてCodexへ返します。中身は暗号化ではなく要約の文章で、本人のCodexの会話ログに保存されます。
- 次の要求でBridgeがこの項目を要約の文章に戻してから送信します。画像生成・検索などOpenAI固有の経路も含め、後でGPTに切り替えた会話でも、印の付いた項目をOpenAIへは送りません。壊れた項目や、`input`の外・入れ子の中など戻せない位置にある項目は、送信前に422で停止します。
- 429の応答に書かれた解除時刻まで（分からない場合は短い既定時間、既定5分・`CODEX_PROVIDER_FALLBACK_COOLDOWN_MS`）、OpenAIには聞かずに最初から選択中のモデルで要約します。長い圧縮で先に行う要約が429になった場合も、同じように応答の解除時刻を使います。記録はOpenAIのアカウント（認証情報と宛先のハッシュ）ごとで、別のアカウントに切り替えるとOpenAIを試します。この記録はrouterのメモリ内だけで、再起動すると消えます。
- 選択中のモデルの提供元もすべて利用上限（402/429）の場合は、HTTP 429（`summary_provider_limits_exhausted`、分かれば`retry-after`付き）で止まり、履歴は保持します。
- 以前にOpenAIの暗号化圧縮を使った会話は、元ログから文章を復元してから要約します（条件は上の「元ログから引き継げる条件」）。復元できない場合は送信前に停止します。
- 代行したときは利用者向けに「OpenAI（要約用モデル）が利用上限のため、選択中のモデルで会話を要約しました」と表示し、routerのログに`remote_compaction_fallback:"selected"`、`remote_compaction_openai_status`、`remote_compaction_openai_skipped`、`remote_compaction_provider`を残します。会話の本文や認証情報はログに書きません。
- 選択中のモデルの要約分の利用量が発生します。要約の質は選択中のモデルに依存し、過去の細部が引き継がれない場合があります。

既存の暗号化checkpointからの復元内容が8MiBを超える場合、何十回もの分割要約や全tool出力の再送を避け、元の要求内のcheckpointだけをOpenAIへ渡して文章化します。巨大な元ログ自体は送信しません。通常の履歴はread-only復元後に選択モデルで要約します。

この設定が制御するのは外部モデル会話の補助要約です。GPTを明示選択した会話や、OpenAI固有の画像・検索機能の利用量を無くす設定ではありません。WhatsToken無料経路の補助要約は、無料時間判定を迂回しないため未対応として停止します。必要な場合はOpenCode・Command Code・Ollamaを明示選択してください。

## 検証

`node --test test/selected-compaction.test.mjs` で上限時の代行（AC-01〜AC-06）を、`python3 test/selected-compaction-app-e2e.py selected`（`openai`も可、`CODEX_BIN`で実行ファイルを指定）で実際のCodex app-serverと模擬上流での圧縮・次の応答・resumeを検証します。`node --test test/history-mode.test.mjs` で、元ログのread-only復元、通常の文章要約のOpenAI要求0件、既存remote compactと巨大履歴の互換処理、DeepSeek/Kimiの提供元別認証、確認モード、元ログ欠落、rollback、symlink、成功要約のキャッシュと認証分離を模擬上流で検証します。実際の長い既存会話の要約精度や情報保持率を保証するテストではありません。

## OpenAI枠切れ・元ログ不足時の引き継ぎ

`selected`で安全な自動復元ができない場合は、残っている文章と手動メモを新しい会話へ渡せます。これは暗号化履歴の解読ではなく**部分復元**です。欠けた内容を推測で補いません。

```sh
# メモに「目的・禁止事項・完了内容・未完了事項・次の作業」を記載する
# 保存だけ。AIへの通信は行わず、本文を標準出力へ表示しない
python3 scripts/rescue_handoff.py --thread <会話ID> --memo /path/to/memo.md

# 内容を確認した後、DeepSeekの新規会話を開始する
python3 scripts/rescue_handoff.py --thread <会話ID> --memo /path/to/memo.md \
  --launch --model opencode/deepseek-v4.1-flash
```

本人の`CODEX_HOME/handoffs/`へ0600のMarkdownを保存します。読める会話の最新側約24,000文字、保存済み文章要約、最大16,000bytesの手動メモを使います。元ログがない場合はメモのみで作成でき、画像・添付・暗号化item・隠れたreasoning・ツール呼び出しと出力は移しません。省略数と対象外を文書へ記載します。分岐・巻き戻し・重複・不正なログは自動処理せず停止します。原本を編集したり、古い会話IDを再利用したりしません。

`--launch`は選択モデルへこの文書を読ませる新規会話です。その後の会話と圧縮には選択した提供元の利用量が発生します。実行前に`portable_history.py --apply`で文章圧縮を設定してください。8790/8791の現在の接続先、モデル、認証、既存profilesは維持します。既存チャットの内部圧縮方式は変更しません。

稼働版のOpenAI明示経路で既存の低料金要約モデルを維持する場合は`CODEX_SUMMARY_MODEL=gpt-6-luna`を設定します。`selected`の外部モデルでの文章要約はこの設定を使いません。既存形式の互換処理ではこの要約モデルを使います。
