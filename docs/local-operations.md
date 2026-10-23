# 本人用ローカル中継の運用

## 接続と信頼する範囲

通常の`codex`と`/model`を使い続けます。GPTはOpenAIへ、OpenCodeモデルはOpenCodeへ
振り分けます。モデルを切り替えると、会話継続に必要な既存履歴も選択先へ送られます。
提供先を増やせない資料を扱う会話では、OpenCodeへ切り替えずGPTのまま使ってください。
このサービスに履歴を匿名化する機能はありません。

8790は、要求のBearerを現在の`CODEX_HOME/auth.json`の本人認証と定数時間で照合します。
8788は、同じ本人認証または内部鍵`CODEX_HOME/bridge-local-token`だけを受け付けます。
内部鍵は256 bitの乱数で、所有者のみが読めるファイルに作成します。URL・引数・Codex設定へ
埋め込みません。認証ファイルを複製せず、更新された認証は要求ごとに読み直します。
資格情報の期限切れや不安全なファイルでは送信を止めます。勝手な他モデルへの代替はしません。

OpenCode認証はAPIキーだけを使います。`OPENCODE_API_KEY`、または本人所有・0600相当の
`~/.local/share/opencode/auth.json`の`opencode-go` API設定を読みます。OpenCodeの
ログインDBやOAuth情報は取り出しません。macOS自動反映では後者のAPI設定を事前確認します。

両サービスはloopbackで待ち受け、ブラウザのOrigin/Fetch Metadata、外部Host、非loopback接続を
拒否します。内部鍵は8788だけへ送信し、ChatGPT認証はOpenAIだけへ送ります。
OpenCodeの上流は公式Go APIに固定し、リダイレクトを追いません。
テストの模擬上流は明示したテスト環境だけで使います。

この境界は別OSユーザーや無認証プロセスからの利用を抑えるものです。同じOSユーザー権限で
すでに侵害されたプロセスは資格情報を読めるため、完全には隔離できません。
複数ユーザーで共有するサーバーや、外部公開するゲートウェイとして使わないでください。
Codex認証をkeychainだけに保存する環境は、現時点ではこの本人照合に未対応です。

## 既存macOS環境への反映

前提はログイン済みCodex（本人所有・0600相当の`auth.json`）、統合接続設定、稼働中の
8790/8788です。最初に`unified_config.py prepare/on`で設定した環境を対象にします。
旧8788は配置先を丸ごと置換せず、既知の認証・ログ・送信先の箇所だけ更新します。

```bash
python3 scripts/secure_local.py doctor
python3 scripts/secure_local.py apply --wait-idle 120
python3 scripts/secure_local.py doctor
```

`doctor`は読取りと無効な認証による拒否プローブだけを行い、推論や設定変更を行いません。
旧サービスではsecurity markerを確認できない限りPOSTしません。秘密の値や本文を表示しません。
`apply`は更新対象のポートにESTABLISHED接続がないことを確認してから更新します。待機中に
接続が空かなければ更新を止めます。Codex・app-server・会話DBは再起動/編集しません。
更新中に新しい会話を開始せず、完了後に再開してください。
8790と8788を個別に確認するため、旧ブリッジだけの更新で稼働中のGPT接続を止めません。

設定とソースは0600のバックアップを作ります。常駐routerは内容のハッシュ別runtimeへ配置し、
稼働revisionと認証拒否を確認します。起動や確認に失敗したサービスは前の登録へ戻します。
旧8788の確認に失敗した場合はソースも復元します。router側の更新が先に成功している場合は、
routerは保護版のまま残ります。最終診断が全項目trueになるまで反映完了と扱いません。
他の処理によるファイル変更、未知の旧版、リンク、危険な権限は上書きせず停止します。

今回の反映は本文dumpを無効にし、別ネットワーク向けの使用量公開（`USAGE_HOST`）も無効にします。
ローカルの使用量画面は本人認証が必要です。既存のdump・ログは無断で削除しません。

## 日常の確認と障害対応

```bash
python3 scripts/secure_local.py doctor
```

- `owner_credentials`: `codex login`の状態とファイル所有権・権限を確認します。
  `auth.json`の内容をIssueやチャットへ貼らないでください。認証形式がkeychainのみなら、この接続方式は利用できません。
- `private_bridge_key`: 内部鍵の安全な所有権・権限を確認します。未作成なら`prepare-key`で作成できます。
  既存の不正ファイルを自動上書きしたり、勝手に鍵をローテーションしたりはしません。
- `opencode_api_credentials`: OpenCode Goの保存済みAPI設定と所有権・権限を確認します。
  ログインだけの状態からOAuthを流用する代替処理はありません。
- `router_protected` / `bridge_protected_dump_off`: サービスが起動し、security markerと401拒否を
  返すことを確認します。`apply`を使ってアイドル時に更新し、実行中プロセスを一括終了しないでください。
- `routing_config`: `unified_config.py normal-on`で接続とカタログを合わせます。
  すでに起動中のTUIに設定が遡及しない場合だけ、作業完了後に`codex`/`codex resume`で起動し直します。

中継を使わない運用へ戻す場合は、元の接続設定を復元します。会話を削除しません。

```bash
python3 scripts/unified_config.py off
```

保護されたサービスを古い無認証版へ戻す運用は推奨しません。障害時はまず中継を外して通常の
Codexへ戻し、Issueへ値を伏せたdoctor結果とrevisionを残して修正します。
バックアップに認証関連の設定が含まれる可能性があるため、Gitへ追加しないでください。

## 開発と更新

認証の実装は`src/local-security.mjs`を両サービスで共有します。個別の修正を配置先だけで
継続せず、Issue→ブランチ→テスト→PR→CIの順で正本へ残します。

```bash
python3 -m unittest discover -s test -p 'test_*.py'
node --test test/*.test.mjs
python3 test/codex-router-e2e.py
MOCK_TOOL_ROUNDTRIP=1 python3 test/codex-router-e2e.py
LEGACY_BRIDGE_SOURCE=~/home-runner/bridge/codex-bridge.mjs node --test test/bridge-transport.test.mjs
```

これらは模擬上流で検証し、有料の推論APIは使いません。模擬キーは一時ディレクトリへ作成し、
利用者の認証と分離します。router-only更新でも、`install_router_service.py --update-if-idle`は
一致するrevisionと不正認証の拒否を確認し、確認失敗時はサービス登録を復元します。

本文dumpは既定で無効です。明示的な隔離環境でのみ`ALLOW_REQUEST_DUMP=1`が有効で、
運用サービスの`DISABLE_DUMP=1`が常に優先されます。上流エラー本文も常駐ログに残しません。
stdoutはサイズ/時間/HTTP状態などの計測に限定します。ログ容量はOS側の監視対象として扱い、
過去のログやdumpを整理する場合は対象を確認してから行います。

Linuxではサービス管理を手動で行い、同じCODEX_HOMEを両サービスへ渡してください。
`secure_local.py prepare-key`後にコードを配置し、`node src/model-router.mjs`と
`node src/codex-bridge.mjs`をloopbackで起動して`doctor`を実行します。
テストのために本番の認証検査を無効にするフラグは用意していません。
