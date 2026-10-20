# codex-bridge

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
