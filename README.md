# codex-bridge

## 同じチャットで GPT ↔ OpenCode を切り替える（統合モード）

モデル名で送信先を選ぶ共通routerを使用できます。GPTはOpenAIへ、
`OpenCode · …` のモデルは既存のOpenCodeブリッジへ転送します。
これにより、チャットに保存されたproviderが`openai`でも`codex-bridge`でも、
接続を読み直した後は、同じ会話ID・履歴のまま対応モデルを切り替えられます。

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

- GPTのモデル名はそのまま使用します。OpenCodeモデルは`opencode/…`の名前空間で区別します。
  同名のモデルが両方にある場合も選択した送信先を維持します。
- ChatGPTの認証はCodexからOpenAIへだけ中継します。OpenCode側へは認証・アカウントの
  ヘッダーを渡さず、認証ファイルのコピーや新しいAPIキーの発行は行いません。
- リクエスト本文やtokenをrouterのログへ保存しません。SSEは逐次転送します。
- provider固有のreasoningは転送先に合わせて取り扱い、freeformツールの履歴・応答を変換します。
  画像、組込みツール、コンテキスト長などは各モデル・providerの対応範囲に従います。
- OpenAI側だけが読める暗号化された圧縮履歴、`item_reference`、`previous_response_id`だけで
  会話を継続する入力は他providerへ持ち出せないため、履歴を黙って捨てず422を返します。
  全履歴を送るCodex 0.163で、同じ会話のGPT→DeepSeek→GPT・逆順を検証しています。
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
node --test test/model-router.test.mjs test/tool-adapter.test.mjs
python3 -m unittest discover -s test -p 'test_*.py'
python3 test/codex-router-e2e.py   # Codex実行ファイル＋模擬接続先。推論APIは呼ばない
RUN_LIVE_ROUTER=1 python3 test/live-router-smoke.py  # 実モデルを3回呼ぶ任意の確認
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
| 暴走ガード | 1分あたりの上限を超えたら 429 を返して停止 |
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
| `MAX_REQ_PER_MIN` | `40` | 暴走ガードの上限 |
| `LOG_LEVEL` | `info` | `debug` で全リクエスト表示 |
| `DISABLE_DUMP` | （なし） | `1` でリクエスト保存を無効化 |

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

`src/models.json` がモデルの定義元です。

```bash
cd src
node sync-models.mjs    # models.dev から最新情報を取得（画像対応・コンテキスト長）
node make-catalog.mjs   # Codex 用カタログと /v1/models 用JSONを生成
```

モデルが追加されたら `sync-models.mjs` → `make-catalog.mjs` の順で実行すれば追従します。

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
```

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
