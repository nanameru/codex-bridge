# codex-bridge

Bridge経由のツール検索と使用量の保持については[通信互換性の修正と検証](docs/tool-search-compatibility.md)を参照してください。

長い会話でのCPU負荷と自動圧縮の設定は[巨大入力の遅延対策](docs/input-latency.md)を参照してください。

## 本人認証とローカル運用

中継の両ポートは本人のCodex認証または内部専用鍵で保護します。本文ログは既定で無効です。
導入・診断・アイドル時更新・復元・履歴の送信先は[ローカル運用手順](docs/local-operations.md)を参照してください。

```bash
python3 scripts/secure_local.py apply --wait-idle 120
python3 scripts/secure_local.py doctor
```

## 公式Responsesへ直接接続する（対応モデル向け）

OpenCode Goの公式案内でResponsesに対応するDeepSeek V4、GPT、Grok、Muse Sparkは、
独自のchat/completions変換を使わずCodexから接続できます。
根拠: https://opencode.ai/v2/docs/console/harnesses/codex/

```bash
python3 scripts/direct_codex.py configure
~/.codex/bin/codex-opencode
```

`opencode-go-direct`という独立したprovider/profileを追加し、
`~/.codex/opencode-go-direct.config.toml`に保存します。既定モデル、既存チャット、
実行中のrouterは変更しません。APIキーは`OPENCODE_API_KEY`、または
`~/.local/share/opencode/auth.json`の`opencode-go`に保存したAPIキーを利用し、
子プロセスの環境変数へ渡します。ログインDB/OAuthは読みません。キーをチャットやGitへ記録しないでください。

このprofileの経路は`Codex → OpenCode公式Responses API`です。通常の履歴圧縮は
Codex標準のlocal compactionが選択モデルへ依頼します。独自routerのGPT要約・ツール変換・
推定トークン上限チェックを通りません。OpenCode側の利用上限はそのまま適用されます。
直接接続でのremote `/responses/compact`は検証時404だったため利用しません。

既存のOpenAI暗号化履歴やBridge固有の推論履歴の自動移行は保証しません。
新しいチャットから使い、移行のために履歴を削除したりGPTへ自動フォールバックしたりはしません。
未対応モデルは従来のBridge経路に残ります。

### 通常の`codex`コマンドと統合モデル一覧で使う

GPTとOpenCodeを同じスレッドで切り替える場合は共通routerを使います。
統合routerは**全OpenCodeモデルを同じChat Completions変換経路へ送信**します。
DeepSeek、GPT、Grok、Muse Sparkも例外ではありません。カタログの
`router_transport`は公式API対応情報として残りますが、統合routerの既定経路は変えません。
旧設定の`x-codex-bridge-direct: 1`が残る接続でも、共通の履歴変換を適用します。

```bash
python3 scripts/unified_config.py prepare
python3 scripts/install_router_service.py --update-if-idle --wait-idle 900
python3 scripts/unified_config.py normal-on
codex
```

既定GPTはOpenAI providerを保持します。既定がOpenCodeなら、モデルを問わず
統合providerを使います。通常会話・ツール履歴は変換して引き継ぎ、OpenAIの暗号化
圧縮履歴は引き継ぎ要約へ変換します。`codex resume`も同じ処理を通ります。
要約にはOpenAIの追加利用が必要で、失敗時は履歴を捨てず停止します。
既存の会話ファイルは書き換えず、実行中のTUIは強制再起動しません。

上記の独立した`codex-opencode`起動だけは公式Responses直結のままです。
同一スレッドの提供元切替には統合routerを使ってください。

## 文章要約でGPTとOpenCodeの履歴を共有する

OSSの仕組みを既存bridge向けに分解した[導入仕様と設定コマンド](docs/portable-history.md)を追加しました。新規統合チャットでCodex標準の文章圧縮を使うための設定をプレビューできます。既存暗号化履歴の移行と画像413の修正は別工程です。

```bash
python3 scripts/portable_history.py        # 変更なしで確認
python3 scripts/portable_history.py --apply
```

## 同じチャットで GPT ↔ OpenCode を切り替える（統合モード）

GPTは標準の圧縮を維持します。OpenCodeへの履歴引き継ぎに時間がかかるときは、CLIの実行中の行へ「履歴を変換中」などを表示します（Appの実描画は未確認）。[表示・設定・検証手順](docs/handoff-status.md)。


モデル名で送信先を選ぶ共通routerを使用できます。GPTはOpenAIへ、
`OpenCode · …` のモデルは既存のOpenCodeブリッジへ転送します。
これにより、チャットに保存されたproviderが`openai`でも`codex-bridge`でも、
接続を読み直した後は、同じ会話ID・履歴のまま対応モデルを切り替えられます。
`/model` の一覧では `OpenCode · DeepSeek V4.1 Flash` と `GPT-6.1-Sol` を先頭2件に固定します。
それ以外のモデルの相対順序は維持します。

```text
Codex ── 共通router（127.0.0.1:8790） ┬─ GPT → OpenAI（既存のCodexログイン）
                                    └─ OpenCode → 既存bridge（127.0.0.1:8788）
```

準備: Node.js 22.16以上、Python 3.11以上、ログイン済みCodex、
OpenCodeブリッジの起動、`models_cache.json`と`model-catalog.json`が必要です。
OpenAIのネイティブカタログはCodexが取得したキャッシュを使用します。

```bash
python3 scripts/unified_config.py prepare
python3 scripts/install_router_service.py   # macOSの常駐設定。他OSはnode src/model-router.mjs
python3 scripts/unified_config.py on
```

既存のアプリやapp-serverは再起動しません。すでに開いていた会話の接続には古い設定が
残ることがあるため、実行中の作業が完了してからアプリを開き直してください。
以降は、そのチャット内のモデル選択で双方向に切り替えられ、毎回の分岐は不要です。

更新時に他の会話が接続中なら、次のコマンドで最大15分、接続が空くまで待機できます。
期限内に空かなければ更新を行わず終了します。

```bash
python3 scripts/install_router_service.py --update-if-idle --wait-idle 900
```

- GPTのモデル名はそのまま使用します。OpenCodeモデルは`opencode/…`の名前空間で区別します。
  同名のモデルが両方にある場合も選択した送信先を維持します。
- OpenCode Goは経路によって実効入力上限がカタログ表示より低いことがあるため、全モデルの
  `auto_compact_token_limit` を50万トークンに設定します。Codexは上流で400になる前に自動圧縮し、
  コンテキストが50万未満のモデルは従来どおり90%の位置で圧縮します。モデル自体の最大コンテキスト表示は
  変更しません。
- ChatGPTの認証はCodexからOpenAIへだけ中継します。OpenCode側へは認証・アカウントの
  ヘッダーを渡さず、認証ファイルのコピーや新しいAPIキーの発行は行いません。
- リクエスト本文やtokenをrouterのログへ保存しません。SSEは逐次転送します。
- 統合routerはOpenCodeの既知の一時エラー `Endpoint is unavailable.` だけ、出力開始前に
  同じモデル・会話・認証で1回再試行します（通常500ms待機）。`Retry-After`が2秒を超える場合や
  一般の利用枠429・認証エラー・通信切断・出力開始後は再送しません。供給側の障害を必ず直すものでは
  ありません。再試行でも失敗した場合は元のエラーを返します。DeepSeekの利用枠・一時429による提供元切替は下記の別機能です。
- provider固有のreasoningは転送先に合わせて取り扱い、freeformツールの履歴・応答を変換します。
  ツール項目IDも型に合わせて `fc_` / `ctc_` を変換し、実行を結び付ける `call_id` は保持します。
  旧版が保存した不整合なIDは通常送信・圧縮・引き継ぎ要約の送信時に補正するため、履歴ファイルの編集は不要です。
  OpenCodeのストリームではreasoning完了をassistant項目の完了より先に渡します。
  旧ストリームでreasoningが後置された履歴も送信時に並べ直し、説明文とツール呼び出しの
  両方へ既存の推論データを引き継ぎます。保存済み会話は変更せず、推論内容の捏造は行いません。
  画像、組込みツール、コンテキスト長などは各モデル・providerの対応範囲に従います。
- OpenAIの暗号化された圧縮履歴からOpenCodeへ切り替えるときは、その会話の圧縮部分だけを
  GPT-6.1 Solで通常の引き継ぎ要約に戻してから渡します。最初の切替には追加のOpenAI呼び出しと
  待ち時間が発生し、そのアカウントでGPT-6.1 Solを利用できる必要があります。元の履歴は変更しません。
  要約は会話・認証・元データごとに分離し、最大64件をメモリ内だけに保存します。
  native GPTの会話にはこの追加処理を行わず、他チャットの選択モデルや全体設定も変更しません。
  要約には通常の会話圧縮と同じく情報の省略があり得ます。要約に失敗した場合は履歴を捨てず停止します。
- `item_reference`、`previous_response_id`だけで会話を継続する入力は他providerへ持ち出せないため、
  履歴を黙って捨てず422を返します。
  全履歴を送るCodex 0.163で、同じ会話のGPT→DeepSeek→GPT・逆順を検証しています。
- OpenCodeが返さないassistant messageの`phase`は`final_answer`へ補完します。
  GPT互換のイベント形式にすることで、Codex TUIで回答が二重表示されるのを防ぎます。
- OpenCodeのremote compactionは未対応です。カタログの掲載は各アカウントの利用権限を
  保証しません。実応答の検証対象はGPT-6.1 SolとDeepSeek V4.1 Flashです。
- routerの実行ファイルは`CODEX_HOME/router-runtime/<revision>/`へ配置されるため、
  Gitのブランチ切替で稼働ファイルが消えません。

元の接続設定へ戻すには次を使用します。独立した設定変更や会話データは保持します。

```bash
python3 scripts/unified_config.py off
```

統合中のメニューバーアプリや`switch.sh on/off`は、最初に選ぶモデルの既定値を切り替えます。
どちらでも同じrouterを使うため、会話中の実際の転送先は選択モデルで決まります。
routerコードの更新は接続中の処理がない時に`install_router_service.py --update-if-idle`で行います。
カタログを更新した場合も、routerをアイドル時に読み直してから有効化してください。

```bash
node --test test/*.test.mjs
python3 -m unittest discover -s test -p 'test_*.py'
python3 test/codex-router-e2e.py   # Codex実行ファイル＋模擬接続先。推論APIは呼ばない
RUN_LIVE_ROUTER=1 python3 test/live-router-smoke.py  # 実モデルを3回呼ぶ任意の確認
```

### GPTとDeepSeekの速度を共通条件で比較する

本番設定やシステムプロンプトを変更せず、既存スクリプトの比較モードで確認できます。
以下は**実APIを合計4回呼び、GPT/OpenCodeそれぞれの利用枠を消費**します。

```bash
RUN_LIVE_ROUTER=1 LIVE_ROUTER_COMPARE=1 python3 test/live-router-smoke.py
```

同じCodexプロセス・作業場所・共通AGENTS・標準ツール・read-only・推論強度lowで、
DeepSeekとGPTを交互に2回ずつ呼びます。各回は履歴なしの新規ephemeralスレッドで、
入力も同じ「こんにちは！」です。共通AGENTSは既存の内容をそのまま使い、
`baseInstructions`の上書きや独自指示の追加はしません。MCP/プラグイン等の利用者設定は
比較用の一時環境には追加せず、本番の設定も変更しません。

出力は最初の回答テキストまでの時間、ターン完了時間、ツール実行数、報告されたtoken usageです。
初期化とthread/startの時間は含みません。usage未報告はnull/欠損で、キャッシュ0とは扱いません。
ツールが実行された場合やエラー時は比較を停止し、自動再試行や別モデルへの代替は行いません。
`LIVE_ROUTER_GPT_FIRST=1`を付けると順序を逆にできます（別実行も4回分消費します）。

モデル固有の既定指示・トークナイザ・推論強度の意味・提供設備は同一化していません。
初回がキャッシュなし、反復がキャッシュありとも保証できません。実際の`cachedInputTokens`を
見て区別してください。キャッシュは提供先をまたいで共有されず、速度改善や同速化を保証する機能ではありません。
一時作業場所はCODEX_HOMEとは別にし、共通AGENTSが作業場所の指示としても読まれる比較上の混入を避けます。

### DeepSeek Flashの標準コードモード（任意）

Codex 0.163.0と公式Go APIで、Flashのコードモードによる`printf`実行と結果返送を確認しています。
既に`normal-on`で公式直接接続を有効にした環境では、次のコマンドでFlashの
`tool_mode=code_mode_only`、`supports_search_tool=true`、`shell_type=unified_exec`だけを変更できます。

```bash
python3 scripts/unified_config.py flash-code-mode
```

カタログはバックアップし、GPT・Pro・他モデル・システムプロンプト・既定モデルは変更しません。
routerの変換処理や新しい常駐プロセスも追加しません。実行中の会話は停止せず、
設定は作業完了後にCodexを起動し直して読み込みます。`prepare`でカタログを再生成した場合は再適用してください。
全てのMCP・ブラウザ操作・画像操作の互換性や、GPTと同じ応答速度を保証するものではありません。

隔離した模擬接続で検証するには次を使います。本番カタログは変更しません。

```bash
python3 test/codex-code-mode-e2e.py
```

実APIの検証は明示的なopt-inで、上流への要求を最大2回に制限します。
同じく本番カタログを変えず、既存のGo APIキーとローカルクライアント用の偽認証で検証します。
GPTへの要求・ログイン認証のGoへの転送・自動fallbackはありません。

```bash
RUN_LIVE_CODE_MODE=1 python3 test/codex-code-mode-e2e.py --live
```

以下は従来の単一providerブリッジの説明です。統合モードでは上記routerが前段に入ります。

**Codex（Responses API）から OpenCode Go の全モデルを使えるようにする翻訳プロキシ。**

```
Codex  ──/v1/responses──▶  codex-bridge  ──/chat/completions──▶  OpenCode Go
                                  │
                                  └─ 認証はOpenCodeのログインをそのまま流用（APIキー不要）
```

ChatGPT アプリ / Codex CLI の中で、DeepSeek・Kimi・GLM・Qwen・Claude・Grok・Gemini などを
そのまま選べるようになります。

---

## なぜ必要か

Codex 0.163 で **`wire_api = "chat"` が廃止** されました。

```
Codex が話せる形式      : Responses API のみ
OpenCode Go の大半のモデル: chat/completions のみ
```

この2つを繋ぐものが無いので、翻訳するプロキシを作りました。

| 経路 | 使えるモデル |
|---|---|
| Codex から OpenCode Go に直接 | `/responses` 対応の3モデルだけ |
| **codex-bridge 経由** | **全モデル** |

---

## できること

| 機能 | 内容 |
|---|---|
| 全モデル | OpenCode Go の全モデル（30超）を Codex から選択 |
| 画像入力 | モデルが対応していれば画像をそのまま渡す |
| Effort | `low` / `medium` / `high` を temperature と指示文に反映 |
| 使用量 | スレッド別のトークン数・概算金額をローカルで記録 |
| 認証 | OpenCode のログイン（OAuth）を流用。APIキー不要 |
| 暴走ガード | スレッド単位で1分あたりの上限を超えたら 429（`Retry-After` 付き） |
| 自動フォールバック | モデルが `/chat/completions` 非対応なら `/responses` に自動切替 |

---

## クイックスタート

```bash
git clone https://github.com/nanameru/codex-bridge.git
cd codex-bridge
./scripts/install.sh          # 環境確認 + モデルカタログ生成
```

ブリッジを起動します。

```bash
cd src
node codex-bridge.mjs
```

別ターミナルで Codex をブリッジ経由にします。

```bash
./scripts/switch.sh on        # ~/.codex/config.toml の既定モデルを切り替える
```

これで ChatGPT アプリのモデル選択に OpenCode Go のモデルが並びます。

切り替えには Python 3.11 以上が必要です。アプリや app-server は自動再起動しません。
反映されない場合は、実行中の作業が完了してからアプリを開き直してください。

```bash
./scripts/switch.sh off       # 切替前の通常モデル設定を復元
./scripts/switch.sh repair    # モデル選択を変えず、欠けた接続定義のみを追加
```

`off` 後も `codex-bridge` の接続定義を残し、既存チャットが接続先を見つけられるようにします。
初回 `on` 前のモデル・provider・カタログを `CODEX_HOME/codex-bridge-switch-state.json`
（既定 `~/.codex/`）へ保存し、繰り返し `on` しても上書きしません。
旧版からの移行で保存情報がない場合、通常モデルだった `config.toml.bak.switch` を参照します。
復元元がない場合は、モデル選択の指定を外して Codex の既定値へ戻します。
バックアップや保存情報はローカルに保持し、Git に含めないでください。

**単一providerモードでは新規チャットの既定設定の切り替えです。既存チャットの接続先は切り替わりません。**
メニューバーアプリの「GPT」表示も既定設定を示します。既存の OpenCode チャットで
モデル名だけを GPT に変えても、そのチャットの接続先は OpenCode のまま残ることがあります。

### 旧メニューバーアプリを使っている場合

`home-runner/app/CodexSwitch` は `~/home-runner/scripts/bridge-switch.sh` を呼びます。
本リポジトリを更新しただけではその旧スクリプトは更新されません。
修正版への入口として `scripts/legacy-switch.sh` を同パスへ配置してください。
元のスクリプトは配置前にバックアップし、実行権限を付けます。
この入口は既定で `~/codex-bridge/scripts/switch.sh` へ転送します。
別の場所へ clone した場合は `CODEX_BRIDGE_HOME` でリポジトリの場所を指定できます。

### GPTに戻した既存チャットが Model is unavailable になる場合

統合モードを有効にして接続を読み直せば、同じチャットでも送信先が切り替わります。
以下の履歴付き分岐は、単一providerモードを継続する場合の復旧方法です。

既存チャットの提供元が `codex-bridge` のまま、OpenCode にないモデル名を送っている可能性があります。
全体設定を通常 Codex へ戻した上で、履歴付きで OpenAI 接続の新しいチャットへ分岐できます。

```bash
./scripts/switch.sh off
python3 scripts/recover_thread.py <元のチャットID> --model gpt-6.1-sol
```

このコマンドは Codex CLI のローカル `app-server` にある `thread/read` / `thread/fork` /
`thread/name/set` を使用します。Codex CLI 0.163 で検証しています。
元の会話と履歴ファイルは保持し、DBや会話ファイルを直接編集しません。
復旧先には「通常Codexで再開: …」という名前を付けます。その新しいチャットを一覧から開いてください。
元の会話を実行中と検出した場合は終了を待ちます。既存のサーバーやアプリの停止・再起動は行いません。
コマンド自体はメッセージを送信せず、推論 API を呼び出しません。通常 Codex の既存ログインを使用します。

チャットIDは Codex が管理するスレッドIDです。復旧後も元のチャットでモデル名だけを
変更して使うと同じ不一致が起き得るため、通常 Codex へ戻す際は復旧先を使ってください。

---

## 仕組み

### 変換の流れ

```
Codex
  │  POST /v1/responses  { model, input[], tools[], reasoning }
  ▼
codex-bridge
  │  ・input[]  → messages[]
  │  ・tools[]  → functions[]
  │  ・effort   → temperature + 指示文
  │  ・画像      → image_url
  ▼
OpenCode Go  /chat/completions
  │  SSE（chat形式）
  ▼
codex-bridge
  │  chat形式 → Responses形式のイベント列に変換
  │  response.created / output_item.added / output_text.delta / completed
  ▼
Codex
```

`/chat/completions` を受け付けないモデル（GPT-6 Luna、Grok 4.7 など）は、
自動的に `/responses` に切り替えてそのまま中継します。

### 認証

2通り、優先度は上から。

1. `OPENCODE_API_KEY` 環境変数
2. OpenCode が保存している OAuth トークン（`~/.local/share/opencode/opencode.db` の `credential` テーブル）

2 の場合、**OpenCode にログインしていれば APIキーを発行せずに使えます。**

---

## 設定

### 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `OPENCODE_API_KEY` | （なし） | 指定するとこちらを優先 |
| `PORT` | `8788` | 待ち受けポート |
| `UPSTREAM_BASE` | `https://opencode.ai/inference/go/openai/v1` | 転送先 |
| `DEFAULT_MODEL` | `deepseek-v4.1-flash` | モデル未指定時 |
| `MAX_REQ_PER_MIN` | `40` | 暴走ガードの上限（スレッド単位） |
| `MAX_REQ_PER_MIN_GLOBAL` | `0` | 全スレッド合計の上限。`0` で無効 |
| `LOG_LEVEL` | `info` | `debug` で全リクエスト表示 |
| `DISABLE_DUMP` | （なし） | `1` でリクエスト保存を無効化 |

暴走ガードはスレッド単位で数え、拒否した要求は数えません。上限を超えた 429 には
`Retry-After`（秒）が付きます。`MAX_REQ_PER_MIN_GLOBAL` を設定した場合だけ、
全スレッド合計の安全上限も働きます。

### Codex 側の設定

`scripts/switch.sh on` が以下を `~/.codex/config.toml` に追記します。

```toml
model = "deepseek-v4.1-flash"
model_provider = "codex-bridge"
model_catalog_json = "/home/you/.codex/model-catalog.json"

[model_providers.codex-bridge]
name = "Codex Bridge (OpenCode Go)"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
stream_idle_timeout_ms = 300000   # 思考中の無音で切断されないように
```

---

## モデル一覧の管理

カタログ生成・同期は外部入力をそのまま信用しません。models.dev の取得は15秒で
タイムアウトし、応答を10MBに制限してHTTP状態とスキーマを検証します。モデルID・
コンテキスト・出力上限・efforts・compactを検証し、表示名からANSIエスケープや
制御文字を除去します。`~/.codex/model-catalog.json` は0600で原子的に書き込み、
シンボリックリンク先へは書き込みません。

OpenCode経路では、ツール定義・instructions・会話履歴を合わせた推定入力トークンを
リクエスト単位で記録します。`OPENCODE_SOFT_LIMIT_TOKENS`（既定900,000）を超えると
古い完了履歴を既存のOpenAI接続で自動要約し、再計測します。ツール定義・指示・最新の
2ユーザーターン（2ターンしかない場合は最新1ターン）と進行中のツール実行は保持し、
元の保存履歴は編集しません。同じ履歴の要約は会話・認証ごとに再利用します。
ユーザーターン境界だけでは収まらない長い作業では、完了したツール交換の境界まで要約対象を
広げます。この場合も直近2件のユーザー依頼を原文で保持し、並列ツールの途中や未完了の
呼び出しは分断しません。固定入力だけで上限を超える場合は停止します。
予算回復の追加要約は1要求につき最大1回で、既存の暗号化圧縮履歴を展開した要求には重ねません。
暗号化圧縮履歴がある場合は、必要に応じて最初の要約範囲を古い完了ターンまで広げます。
必要な場合だけOpenAIへの要約要求が発生します。
この要約は既存のOpenAI認証と`gpt-6.1-sol`（既定）を利用するため、DeepSeek選択中でも
OpenAI側の利用枠を消費します。履歴要約キャッシュのhitは、OpenCode側の入力キャッシュhitを意味しません。
`OPENCODE_AUTO_BUDGET_HANDOFF=0` で自動要約を無効にできます。
ツール定義や最新入力だけで大きすぎる場合など、要約後も
`OPENCODE_HARD_LIMIT_TOKENS`（既定1,000,000）を超えると、OpenCodeへ送らず413を返します。
要約が失敗した場合も履歴を捨てず停止します。再計測後もsoft limit超過なら`budget_warning`を記録します。
推定値はASCII/非ASCIIを考慮した保守的な値で、必要に応じて環境変数で調整できます。
soft limitがhard limitを超える設定ではhard limitを回復開始点とし、`budget_limit_clamped`を記録します。

`src/models.json` がモデルの定義元です。

```bash
cd src
node sync-models.mjs    # models.dev から最新情報を取得（画像対応・コンテキスト長）
node make-catalog.mjs   # Codex 用カタログと /v1/models 用JSONを生成
```

上記は固定カタログを手動生成する場合の手順です。新モデルへの自動追従には、[動的モデルカタログ](docs/live-catalog.md)を使います。OpenCode Go自身の提供モデルAPIを正本として取得し、Codexのモデル一覧と中継ルートを無停止で更新します。

---

## 使用量の確認

```
http://127.0.0.1:8788/usage
```

スレッドごとの入力・出力トークンと概算金額が出ます。データは
`~/.home-runner/usage.json` に保存されます。

```bash
curl "http://127.0.0.1:8788/usage?json"
```

---

## テスト（APIキー不要）

```bash
node test/mock-upstream.mjs &
OPENCODE_API_KEY=dummy UPSTREAM_BASE=http://127.0.0.1:8799/v1 \
  node src/codex-bridge.mjs &

curl -s http://127.0.0.1:8788/health
curl -s -X POST http://127.0.0.1:8788/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","input":"hello"}'
```

---

## 制限・できないこと

| 項目 | 状態 | 理由 |
|---|---|---|
| Codex ネイティブの computer-use | ❌ | OpenAI 認証のプロバイダにしか公開されない |
| アプリ内の金額表示 | ❌ | OpenAI の価格表から計算されるため |
| `web_search` などの組み込みツール | ❌ | chat API に対応物が無い |
| ChatGPT の利用上限チェック | 対象外 | アプリはアカウント上限で入力をブロックする（CLI は通る） |

**computer-use の代替**: Codex には `cua_repl` という MCP が同梱されており、
そちらはプロバイダに関係なく使えます。モデルに `cua_repl` を使うよう明示すると動きます。

---

## トラブルシューティング

### 「Reconnecting... waiting for network」が繰り返される

1. ブリッジが動いているか確認

   ```bash
   curl http://127.0.0.1:8788/health
   ```

2. 止まっていれば起動し直す

3. 思考が長いモデルでは `stream_idle_timeout_ms` を上げる（既定 5 分）

### 同じ文章が2回表示される

`codex exec` の仕様です。ストリーミング表示と確定メッセージが両方出ます。
セッションファイルには1回しか記録されません。

### 画像が渡らない

選択中のモデルが画像非対応だと、Codex が画像を送らずに捨てます。
`src/models.json` の `vision` を確認してください。

### 設定を壊した

新しい切替処理は、変更のたびに `~/.codex/config.toml.bak.switch.<一意な文字列>` へ
バックアップを作成します。旧版の `config.toml.bak.switch` も上書きせず保持します。
`CODEX_HOME` を指定した場合、保存先もそのディレクトリになります。

`Model provider 'codex-bridge' not found` が出た場合は、まず接続定義だけを修復します。

```bash
./scripts/switch.sh repair
```

### リモート利用中に「別のアプリで開いています」と表示される

これはチャットの書き込み権限の競合を示す表示です。ログの
`already has an active writer` は、別のサーバー等がそのチャットの書き込み権限を
保持していることを示します。リモート再接続で元のサーバー以外へ接続して発生した
[報告](https://github.com/openai/codex/issues/49268)もありますが、原因は環境ごとに確認が必要です。

他の端末の同じチャットや自動 SSH 接続を確認し、実行中の処理が終わってから
不要なクライアントの接続を閉じて「再試行」してください。元の処理が継続していることもあります。
ロックファイルや会話 DB の削除、全サーバーの強制終了は行わず、競合している接続を特定します。
本スクリプトはアプリやサーバーを再起動しませんが、Codex 側のリモート再接続競合そのものを
修正するものではありません。

### 設定切替の回帰テスト

外部 API や起動中のアプリに触れず、一時 `CODEX_HOME` で検証できます。

```bash
python3 -m unittest discover -s test -p 'test_*.py'
node --test test/model-router.test.mjs test/tool-adapter.test.mjs
```

ローカルCodexと既存カタログがある場合、偽認証・模擬接続先だけで両方向の切替と保存会話の
再開を確認できます。後者は説明文・ツール呼び出し・後置reasoningを再現し、8ターンで16リクエストを検証します。

```bash
python3 test/codex-router-e2e.py
MOCK_TOOL_ROUNDTRIP=1 python3 test/codex-router-e2e.py
```

実モデルによる任意の確認は、既存のログインを使用するephemeral会話で3ターン実行します。
`LIVE_ROUTER_TOOLS=1`では各ターンに無害な`printf`を2回実行します。実際の利用枠を消費します。
既存ログインとカタログだけを権限600の一時設定へコピーし、検証終了時に削除します。
ユーザーのモデル設定やMCP設定は変更しません。`LIVE_ROUTER_BASE_URL`で別のloopback `/v1`を検証できます。

```bash
RUN_LIVE_ROUTER=1 LIVE_ROUTER_TOOLS=1 python3 test/live-router-smoke.py
```

圧縮履歴を持つ会話の接続確認は、元のrolloutを変更せずに行えます。既存ログインを使い、
圧縮部分をOpenAIで要約してからOpenCodeの実応答を確認するため、両モデルの利用枠を消費します。

```bash
RUN_LIVE_ROUTER=1 python3 test/live-compaction-smoke.py --rollout /path/to/rollout.jsonl
```

### Command Code / Ollama CloudのDeepSeekを手動で選ぶ

共通ルーターへ次の2件を追加できます。この2件は`/model`で明示的に選ぶ固定ルートです。

| 一覧の表示 | CodexのモデルID | 公式APIに送るmodel |
| --- | --- | --- |
| Command Code · DeepSeek V4.1 Flash | `commandcode/deepseek-v4.1-flash` | `deepseek/deepseek-v4.1-flash` |
| Ollama Cloud · DeepSeek V4.1 Flash | `ollama/deepseek-v4.1-flash` | `deepseek-v4.1-flash` |

今回はDeepSeek V4.1 Flashだけです。Command Codeは[Provider API](https://commandcode.ai/docs/provider)、
Ollamaは[Cloud API](https://docs.ollama.com/api/openai-compatibility)のChat Completionsを使用します。
モデルIDとcontextは公式モデル一覧/`api/show`で確認しています。利用枠や契約プランの購入はこの機能では行いません。

各社の公式画面でAPIキーを作成し、次のコマンドへ非表示入力してください。チャットやシェルコマンドの引数へキーを書かないでください。

```bash
python3 scripts/manual_providers.py set-key commandcode
python3 scripts/manual_providers.py set-key ollama
python3 scripts/manual_providers.py install-models
python3 scripts/install_router_service.py --update-if-idle --wait-idle 900
```

キーは`CODEX_HOME/commandcode-api-key`と`CODEX_HOME/ollama-api-key`へ本人専用の0600権限で保存します。
専用環境変数`CMD_API_KEY` / `OLLAMA_API_KEY`がある場合はそちらを優先します。
共有権限・symlink・hardlinkの鍵ファイルは読みません。OpenAIログインと他社のキーを混ぜません。
設定コマンドは既定モデルや既存会話を書き換えず、モデル一覧のバックアップを作ります。手動用2項目と自動用2項目を追加します。
常駐ルーターはキーの変更を要求ごとに読み込むので、キーの登録/更新だけなら再起動不要です。

Codex Appは会話を完了してから開き直し、CLIで一覧が古い場合は
`codex resume <thread-id> --no-daemon`で再読込してください。
動的な一覧更新でも、この2件は既存OpenAI/OpenCodeモデルと共存します。

通常の`codex`でも古い一覧が出る場合、画面が既存の共有app-serverへ再接続している可能性があります。
`scripts/codex_fresh.py`は通常起動・prompt付き起動・`resume`・`fork`へ公式`--no-daemon`を付け、最新設定を読む専用serverを使います。
明示的なremote接続、既存の`--no-daemon`、`exec`や`agents`等の非TUIコマンドは変更しません。
Codex0.164のoption値と`--`を区別し、未知optionは実CLIへそのまま渡します。
本人環境では、公式installerの管理外である`~/.codex/bridge-cli/bin/codex`へ配置し、隣の`codex-real`を公式`standalone/current/bin/codex`へリンクします。
`~/.zshenv`の管理ブロックで`codex`関数からこの入口へ全引数を渡します。Herdrが使う`codex resume <ID>`も対象です。
公式installer所有の`~/.local/bin/codex`は書き換えません。シェル設定は原文をprivate backupしてから追記し、新しいシェルで読み込みます。
独自launcherや既存の同名管理ブロックを無断で上書きしないでください。
専用serverの起動では共有CLIのモデル表示同期と共有serverからの実行中セッション管理は対象外です。
配置後は新しいシェルから`codex`を起動し、実画面の`/model`で一覧を確認してください。起動済み画面の一覧はこの変更では再読込されません。
Herdrを開き直しても以前のシェルが残る場合があります。そのシェルでは管理関数も未読込のため、Codexを終了したシェルで一度読み込む必要があります。
また、保存済みの会話でも共有serverが保持中なら専用serverへの再開はロックされます。通常の終了だけで即移行できるとは限りません。
同じIDを保持した移行の確認手順と制約は[既存画面のモデル一覧復旧](docs/cli-model-reconnect.md)を参照してください。
また、初回turn前の未保存liveセッションは別serverへ`resume`できません。`ephemeral=false`や共有serverの`thread/read`成功だけでは保存済みの証拠になりません。
該当IDを別の会話へ置き換えたり、保存のためにダミー発言を送ったりせず、保存状態と一覧の問題を分けて確認してください。

この2件の手動指定では、APIキー未登録は`provider_key_required`で止まります。認証失敗・429・利用枠切れでも他社へ切り替えません。
履歴引き継ぎ/圧縮だけは既存のOpenAI要約経路を使い、その後の通常要求は選択したサービスへ戻ります。
最新依頼・指示・未完了ツール・schemaを保持し、既存の入力予算と分割要約を適用します。
新しいChat経路も会話単位の40要求/分の制限と、routerの300秒/転送byte制限に従います。
Command Codeの画像入力はこの初期設定では提供せず、Ollama側だけ公式vision capabilityに基づき有効です。

実APIへ送らずに4社の一覧・同一会話の手動切替・圧縮後の選択保持・保存再開を確認できます。

```bash
node --test test/manual-providers.test.mjs
python3 -m unittest discover -s test -p test_manual_providers.py
python3 test/manual-providers-e2e.py
```

### 応答待ち時間の改善と計測

圧縮済み履歴を初めてOpenCodeへ引き継ぐときは、OpenAIでの要約が先に必要です。
同じ会話・認証・圧縮履歴の要約をメモリ内で最大64件再利用し、同時要求も1回の要約を共有します。
指示文や表示用IDの変更では再要約しませんが、現在の指示は毎回保持します。
会話ID不明・認証更新・圧縮履歴の変更・router再起動では再利用しません。要約はディスクに保存しません。
要約の`response.completed`を受信した時点で次へ進み、接続の終了まで待ち続けません。

要約モデルにも入力予算を設けています。既定20万tokensと要約先カタログのcontext上限の80%の小さい方を使い、
出力予約16384tokensを含めて事前判定します。巨大な履歴は上限内の断片に分け、前の要約を次へ引き継ぎます。
要約側が`context_length_exceeded`を返した場合は失敗要求の推定サイズから履歴用の予算を半減して再分割し、出力予約は保持します。
全体で最大32要求（各断片の一時失敗の再試行も含む）、router全体の既存タイムアウト内で停止します。
分割したツール履歴は実行可能な呼出しではなくデータとして要約し、画像と暗号化itemは切断しません。
途中失敗・取消では全体要約を完成扱いせず、元の履歴を保持します。
検証済みの完了チャンクは、履歴順序・スレッド・認証・送信先・モデルを照合して再試行時に再利用します。
チャンクの保持はメモリ内の最大64件で、再起動や追い出しで失われます。途中の全体要約を会話へ公開しません。

`compaction_trigger`のOpenAI転送は圧縮専用です。ツール定義は送りません。
その要求にも同じ入力予算を適用し、必要なら完了済み履歴を先に段階要約します。
最新依頼・指示・未完了ツールだけで予算を超える場合は、破棄せず`summary_input_budget_exceeded`で停止します。
通常会話の選択モデルや全体設定は変更しません。要約には情報損失と追加の利用枠消費があり、
画像・暗号化item単体の過大、保護入力の過大、要求数上限、外部障害では回復できない場合があります。

OpenCode向け入力は、隣接して完全一致する指示だけを取り除きます。
最新依頼・ツール結果・推論履歴の任意切捨てはしないため、大量の履歴を持つ会話が必ず短時間になるわけではありません。
元の会話・全体のモデル設定・OpenAIへの入力は変更しません。

DeepSeek V4の選択済み推論強度は、温度や短文指示だけでなく実際の`thinking`と`reasoning_effort`へ変換します。
`none`は思考なし、`minimal/low`は`low`、`medium/high/xhigh`は`high`、`max/ultra`は`max`です。
未指定時は上流既定を保ち、未対応モデルへこれらのパラメータは送信しません。
[DeepSeek公式仕様](https://api-docs.deepseek.com/guides/thinking_mode/)に基づく変換です。
OpenCodeへ送るセッションIDも、プロセス共通ではなく会話IDから作るUUID v5（36文字）にします。
実接続で68文字のハッシュ形式が429、UUID形式が200となる組合せを確認したため、UUID形式へ揃えています。
[Go公式のセッション要件](https://opencode.ai/docs/go/#where-can-i-use-it)に沿ったもので、会話をまたぐ選択の共有は行いません。

CLI起動のrouterは、リクエストごとにJSONの計測ログを出します。
macOS常駐時は`~/.codex/log/model-router.log`で確認できます。

- `summary_cache`: `unused` / `miss` / `shared` / `hit`
- `summary_ms`: 要約生成または再利用を待った時間
- `summary_requests` / `summary_chunked`: 要約API要求の総数と段階要約の有無
- `summary_input_tokens`: 直近の要約要求の推定入力tokens
- `remote_compaction_prepared`: 圧縮専用要求の前処理を完了したか
- `upstream_headers_ms`: 最終送信先の応答ヘッダまでの時間
- `first_upstream_byte_ms`: 最終送信先の最初のデータまでの時間（回答の最初のトークンとは異なる）
- `upstream_stream_ms` / `total_ms`: 本文転送時間 / 入力受信を含む合計時間
- `received_bytes` / `forwarded_bytes` / `response_bytes`: 受信wire / 変換後送信 / 上流本文のbytes（トークン数ではない）
- `outcome`: `complete`（転送完了）/ `rejected`（HTTPで拒否）/ `aborted`（クライアント中断）/ `timeout`（期限超過）/ `failed`（上流・変換処理の障害）
- `termination_reason`: `client_request_aborted` / `client_disconnected` / `deadline_exceeded` / `upstream_error` / `upstream_stream_error`。最初の終了原因を保持する
- `transport_error_code`: 許可した通信エラーコードのみ。例外の生message・上流URLは保存しない

本文・認証・会話ID・キャッシュキーは記録しません。`complete`は転送完了であり、HTTP 200内のモデルエラーがないことまでは保証しません。
上流ストリームの障害や期限超過は、接続が残っていればSSEの終端`response.failed`で固定文の理由を返します。
HTTP 200が既に送られていても`outcome`は障害として記録し、途中回答の再推論やサービスの自動切替は行いません。
実Codexでの通知確認は`python3 test/stream-error-e2e.py`で実行できます。
隔離した設定・合成APIキー・模擬上流だけを使用します（ローカルに`codex`が必要）。

### 既存のhome-runner版への反映

`~/home-runner/bridge/codex-bridge.mjs`は、推論履歴・通信タイムアウト等の追加修正を持つ別実装です。
repoの旧ブリッジで丸ごと置き換えないでください。専用スクリプトで既知の箇所だけ更新します。

```bash
python3 scripts/patch_legacy_bridge.py ~/home-runner/bridge/codex-bridge.mjs
LEGACY_BRIDGE_SOURCE=~/home-runner/bridge/codex-bridge.mjs node --test test/bridge-transport.test.mjs
```

前者は確認のみ、後者は一時コピーを更新して模擬上流で検証し、本番ファイルには触れません。
本番反映を承認してから、ファイルのバックアップ付き更新とrouterの接続待ち更新を行います。

```bash
python3 scripts/patch_legacy_bridge.py ~/home-runner/bridge/codex-bridge.mjs --apply
python3 scripts/install_router_service.py --update-if-idle --wait-idle 120
```

推論設定・会話セッションの変更は8788のプロセス再起動後に有効になります。
このスクリプトは8788を再起動しません。実行中の会話がないことを確認してから管理元のサービスだけを再起動してください。
routerのキャッシュ・計測だけを更新しても、旧8788の推論設定は変わりません。

---

## 常駐させる（macOS）

`launchd` で自動起動する場合の例です。

```bash
cat > ~/Library/LaunchAgents/com.example.codex-bridge.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.example.codex-bridge</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/env</string><string>node</string>
  <string>/path/to/codex-bridge/src/codex-bridge.mjs</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.codex-bridge.plist
```

Linux なら systemd の `Restart=always` を使います。

---

## 注意

- OpenCode Go の利用規約に従って使用してください
- このプロキシは**自分のアカウントの認証を自分のマシン内で使う**前提です。他人に公開しないでください
- `127.0.0.1` のみで待ち受ける設計です（外部公開しない）

---

## ライセンス

MIT

### DeepSeekの利用枠に応じた自動切替

通常の`opencode/deepseek-v4.1-flash`を選ぶと、OpenCode Go → Command Code → Ollama Cloudの順で使います。
手動プロバイダー有効時の既定動作で、認証情報とカタログのある候補だけが対象です。
上流から402、利用枠枯渇を明確に示す429、または一般の混雑429が返ると、同じ要求を次の候補へ送ります。
一般の429では同一提供元へ再送せず退避します。ローカル40要求/分ガード、401/403、400、5xx、接続失敗では切り替えません。
成功応答やツール出力の転送を始めた後も再送しません。切替チェーンは最大3候補です（既存の同一サービスへの一時エラー再試行は別）。
履歴準備の進捗表示はモデル出力と区別し、圧縮済みの履歴・最新依頼・ツール結果をそのまま引き継ぎます。
Command Codeで画像入力は提供しないため、画像付き要求の能力制約は固定ルートと同じです。

5時間・週間・月間・期限不明の制限を個別に記録し、重なった制限がすべて期限切れになるまでその提供元を避けます。
応答の`Retry-After`、resetヘッダー、JSON時刻、`Resets in 2h 41m`などを使います。
解除時刻がない場合は既定5分のクールダウンです。期限後の**次のリクエスト**で最優先の利用可能な提供元へ戻ります。
OllamaからOpenCodeへ直接戻ることもできます。バックグラウンド推論・定期ポーリングは行いません。
一般の429は利用枠切れと分けてメモリ内だけで追跡し、既定30秒、`Retry-After`があれば1秒〜5分の範囲で待ちます。
この一時制限の期限後も、週間・月間などの利用枠制限が残る提供元には戻りません。
全社制限中は`provider_limits_exhausted`と`Retry-After`で停止します。キー未登録候補は飛ばし、認証拒否を枯渇と推測しません。

共有サーバーに接続するCLIでは選択モデルも実提供元へ追従します（次項）。要求ごとの実提供元をメトリクス`provider`と`fallback_providers`へ記録します。
ヘッダー確定前なら応答の`x-codex-bridge-provider`でも確認できます。
状態は`CODEX_HOME/provider-fallback-state.json`へ0600・atomic replaceで保存し、再起動後も復元します。
保存するのは固定の提供元名・窓・期限・HTTP分類だけで、APIキー・会話ID・本文は保存しません。
保存できない場合はそのプロセス内の制限を維持し、`provider_state_error`を記録します。
`CODEX_AUTO_PROVIDER_FALLBACK=0`で従来の固定経路に戻せます。
`CODEX_PROVIDER_FALLBACK_COOLDOWN_MS`は解除時刻不明時の再確認間隔（既定300000ms、最小1000ms）です。
設定変更は常駐サービスを安全に更新してから有効になります。

各社共通の残量APIはなく、使用額から上限を推測せず、実際の上限応答に基づいて判断します。
[OpenCode Go](https://opencode.ai/v2/docs/console/go/)はモデル別の月間枠に加え5時間20%・週間50%の枠です。
[Command Code](https://commandcode.ai/docs/resources/usage-limits)は5時間・7日・請求月の枠で、
既存top-upがある場合は提供元側で自動消費されることがあります。枠のboostを短期枠へ比例換算しません。
[Ollamaの現行プラン](https://ollama.com/pricing)は月間credits制で、旧セッション/週間制限は適用されません。
購入・契約・auto reload設定は変更しません。未課金の402も期限不明として扱うため、購入せずに次の候補か全社停止へ進みます。

```bash
node --test test/provider-fallback*.test.mjs
python3 test/provider-fallback-e2e.py
```

### CLIの選択モデルも連動させる

通常起動のCodex CLI（0.164.0の共有app-server）では、切替・復帰時に
`thread/settings/update`で選択モデルを更新し、footerとモデル選択状態も追従します。

| 選択ID | 動作 |
| --- | --- |
| `opencode/deepseek-v4.1-flash` | OpenCodeを優先する自動切替の開始点 |
| `auto-commandcode/deepseek-v4.1-flash` | 「自動切替」付きCommand Code。解除後は上位へ戻る |
| `auto-ollama/deepseek-v4.1-flash` | 「自動切替」付きOllama。解除後は上位へ戻る |
| `commandcode/deepseek-v4.1-flash` | 本人が選ぶ固定経路 |
| `ollama/deepseek-v4.1-flash` | 本人が選ぶ固定経路 |

固定項目を手動で選び直すと自動切替を停止します。自動用項目なら利用可能な最上位から再開します。
Codex自身が選択IDを保存するため、会話ID対応表を作らずに保存再開後も同じ動作を維持します。
進行中turnを中断せず、承認やsandbox設定も変更しません。更新直前に現在のモデルを再確認し、
観測済みの手動変更を上書きしません。設定APIにcompare-and-swapはないため、複数clientの完全同時操作はサーバーの適用順に従います。

control socketは所有者・0600権限・親ディレクトリを検証します。読取/モデル設定更新だけを使い、
本文・秘密・会話IDを新たに保存せず、threadの購読やtool/承認requestへの応答も行いません。
接続名が`codex-live`等でも、`config/read`の定義が当該ルーターの待受port・`/v1`を指し、
`requires_openai_auth=true`なら同期します。外部URL・別port/path・認証不要のproviderは対象外です。
検査結果のprovider名だけを30秒/接続単位でcacheし、設定値や秘密を記録しません。
接続できなくても推論ルートを維持し、同期失敗は`cli_model_sync`と固定カテゴリの`cli_model_sync_reason`へ記録します。
`CODEX_CLI_MODEL_SYNC=0`で表示同期を無効化できます。`--no-daemon`のCLIやAppの表示同期は対象外です。

項目の追加は`python3 scripts/manual_providers.py install-models`で行います。
起動済みのCLI/共有サーバーが古いカタログを保持する場合も選択IDは変わりますが、新項目は
`auto-commandcode/...`のようなID表記になります。表示名の取り込みは全チャットの作業完了後、
共有サーバーとCLIを再起動した際に行われます。設定ツールは他チャットを止める再起動を行いません。

### クレジット・認証エラーの案内

402、明確な利用枠429、401/403、APIキー未登録の場合は、公式ログインとプラン/支払いリンクを表示します。
無料プランか残高不足かはHTTP状態だけで断定しません。全社制限中は3社のリンクをまとめます。
切替で継続できた場合も、枠に達した提供元のリンクをbridge commentaryでCLIへ表示し、次の推論入力から除きます。

| 提供元 | ログイン | プラン・支払い |
| --- | --- | --- |
| OpenCode | https://opencode.ai/console/ | https://opencode.ai/console/go |
| Command Code | https://commandcode.ai/signin | https://commandcode.ai/billing |
| Ollama | https://ollama.com/signin | https://ollama.com/pricing |

固定の公式URLだけを使い、上流URLやAPIキーは表示しません。ブラウザの自動操作、購入、契約、auto reload設定変更は行いません。

```bash
node --test test/cli-*.test.mjs test/provider-help.test.mjs
python3 test/cli-model-sync-e2e.py
CODEX_TEST_STALE_CATALOG=1 python3 test/cli-model-sync-e2e.py
```

### WhatsTokenの無料時間帯だけ優先する

通常版`deepseek-v4.1-flash-1017`を、Asia/Singapore（UTC+8）の毎日22:00〜翌08:00だけ自動経路の先頭へ追加できます。時間外・キーなし・無料料金未確認・利用不可時はOpenCode→Command Code→Ollamaへ戻ります。本人が固定指定したCommand Code/OllamaやGPTは切り替えません。

```sh
python3 scripts/manual_providers.py set-key whatstoken
python3 scripts/install_router_service.py --update-if-idle --wait-idle 900 --enable-whatstoken-free
python3 scripts/manual_providers.py install-models --with-whatstoken-free
```

キーは非表示入力で`~/.codex/whatstoken-api-key`へmode 600で保存します。購入・入金は行いません。トークンはHAをOFFにし、Limit modelsで通常版だけに制限する構成を推奨します。`special`版は対象外です。トークンのquota=0を無料制限とは扱いません。

明示有効化は`CODEX_WHATSTOKEN_FREE=1`です。無料の確認には固定した公式公開料金と運用timezoneを使い、2秒の取得期限・1MiBの上限・リダイレクト拒否・5秒以内の短いcacheを設けています。無料設定の変更、曖昧なモデル、未知の料金ルール、時計ずれ、取得失敗を認めません。無料終了の直前はルーターの要求期限＋5秒の余裕を取ってWhatsTokenへ新規送信しません。判定を通過後も、モデル送信直前と回答再取得時に再確認します。提供元が処理途中に料金や規約を変更した場合の将来請求を保証する契約ではありません。

自動選択中の表示IDは`auto-whatstoken/deepseek-v4.1-flash`です。接続中のCLIの表示も同期し、次の要求で時間外なら既存の上位提供元へ戻ります。ヘッダー受信前のWhatsTokenの認証・残高・レート・通信エラーでは既存経路へ移ります。ストリームを受け取った後は自動再推論を増やしません。
WhatsTokenのヘッダー前エラー後は、連続失敗を避けるため1分間は無料経路を休止します。利用枠の解除時刻が分かる場合は既存の枠追跡も使います。バックグラウンドの試し推論は行いません。

会話本文、履歴、コード、画像、ツール結果はWhatsTokenと上流へ送信されます。[プライバシーポリシー](https://www.whatstoken.ai/legal/privacy)は処理・第三者転送・ログ保持を認めています。保存国/日数/学習不使用を保証する記載は確認できていません。送信本文から登録済みの提供元キー・現在の認証キーを伏せますが、未知の個人情報や機密情報を自動で匿名化するものではありません。ローカルの履歴は変更しません。

模擬通信の確認:

```sh
node --test test/whatstoken-free.test.mjs test/whatstoken-router.test.mjs
CODEX_TEST_WHATSTOKEN=1 CODEX_TEST_MODEL_PROVIDER=codex-live python3 test/cli-model-sync-e2e.py
```

後者も隔離設定・合成キー・模擬上流のみです。料金や疎通の確認のために有料時間帯の実推論は行いません。
