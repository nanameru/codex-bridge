# 配布版でKimi・DeepSeekを使う（macOS）

通常の `codex` → `/model` でKimi K3.1 ProとDeepSeekを使う手順です。
各利用者が自分の契約・公式APIキーを用意します。このBridgeは非公式の連携ツールです。

## 前提

- macOS、zsh、Node.js 22.16以上、Python 3.11以上。
- 公式standalone版Codexを一度起動・ログインして終了してあること。
  起動入口は `~/.codex/packages/standalone/current/bin/codex` の配置を対象とし、Codex 0.164.0で検証しています。npm版など別の配置は自動で書き換えません。
- `~/.codex/config.toml`、`models_cache.json`、本人所有で安全な権限の`auth.json`があること。keychainのみの認証には未対応です。
- Command CodeのAPI対応プランとAPIキー。OpenCode経由のDeepSeekにはOpenCode GoのAPIキーも必要です。

以下は標準ポート8788/8790を使う構成向けです。別ポートや独自launcherを使う場合は上書きせず現行構成を確認してください。
本人Macの8791への反映は[作業記録](kimi-deepseek-rollout.md)に分けています。

## 新規導入

Releaseのソースを展開するか、次のように取得し、そのディレクトリで実行します。
各コマンドの成功を確認してから次へ進んでください。

```bash
git clone https://github.com/nanameru/codex-bridge.git
cd codex-bridge
./scripts/install.sh
python3 scripts/unified_config.py prepare
python3 scripts/manual_providers.py set-key commandcode
python3 scripts/manual_providers.py install-models
```

`set-key`は非表示入力です。キーをコマンド引数やチャットへ貼らないでください。
Command Codeのキーだけでも同社のKimiとDeepSeekを使えます。
OpenCodeのキーは本人の`~/.local/share/opencode/auth.json`の`opencode-go` API設定、または
ブリッジを起動するターミナルの`OPENCODE_API_KEY`で用意します。OAuthやログインDBは使用しません。

別ターミナルを同じリポジトリで開き、OpenCodeブリッジを起動しておきます。
現行の統合構成では、OpenCodeを使わない場合もこのサービスを起動します。

```bash
node src/codex-bridge.mjs
```

元のターミナルで統合router・接続設定・通常起動の入口を順に設定します。

```bash
python3 scripts/install_router_service.py --update-if-idle --wait-idle 120
python3 scripts/unified_config.py on
python3 scripts/install_fresh_cli.py
```

新しいzshのターミナルで `codex` → `/model` を開き、選択して短い挨拶を送ってください。

- `Command Code · Kimi K3.1 Pro`
- `Command Code · DeepSeek V4.1 Flash`
- `OpenCode · DeepSeek V4.1 Flash`（OpenCodeのキーがある場合に利用可能）

キー未登録の提供元も一覧に表示されますが、送信時には停止します。他社へ勝手に切り替えません。
起動済みの画面は一覧を再読込しないので、終了して新たに起動してください。

## 更新

Git導入なら作業ツリーに自分の変更がないことを確認して `git pull --ff-only`、Releaseなら新版を別ディレクトリへ展開します。
利用中の会話を完了してから、新版のディレクトリで実行します。

```bash
python3 scripts/manual_providers.py install-models
python3 scripts/install_router_service.py --update-if-idle --wait-idle 120
python3 scripts/install_fresh_cli.py
```

標準カタログから再生成する場合だけ、`install-models`の前に `unified_config.py prepare` を実行します。
更新後はCodexを終了して起動し直します。待機が時間切れなら強制停止せず、会話が空いてから再実行してください。
公式Codex更新後も新zshの管理関数は安定入口を使います。古いshellの入口が置換された場合は、同じ`install_fresh_cli.py`で修復できます。

## 利用上の条件

通常の返答は選択した提供元の公式APIへ送ります。履歴の引き継ぎ・圧縮ではOpenAIにも送信し、追加の利用量が発生することがあります。
特にremote compaction v2の互換処理、暗号化済み圧縮履歴の引き継ぎ、入力上限対策の追加要約が対象です。
選択モデルだけで全ての圧縮が完結する構成ではありません。モデル切替時は既存履歴も選択先へ送られます。
上流の料金・利用枠・429制限はそのまま適用されます。Kimiはテキストとツール呼び出しを検証しており、画像や全ての長い既存履歴は保証しません。

配布物にはCodex本体・モデル・APIキー・利用者の設定や会話データを含みません。APIキーや利用枠を他人と共有しないでください。
BridgeのMITライセンスを保持してください。商標と各サービスの利用条件は別です。

## 配布前の確認

```bash
python3 scripts/run_test_inventory.py --output /tmp/codex-bridge-test-results
python3 test/manual-providers-e2e.py
```

前者は自動回帰テスト、後者はインストール済み実Codexと模擬APIによる一覧・切替・圧縮・再開の確認です。
後者には上記のカタログが必要です。模擬キーは一時設定へ隔離し、実推論APIには送信しません。
各利用者の実サービスでの動作には、自分のキー・利用枠と短い疎通確認が別途必要です。
