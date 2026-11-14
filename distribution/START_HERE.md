# はじめに：Codex Bridge 配布版

このフォルダを ZIP から展開し、`AGENTS.md` を Codex に読ませてください。Codex 自体、API キー、アカウント、個人の設定は含まれていません。自分が契約したサービスと対応モデルを選びます。外部サービスへ会話が送られ、料金が発生する場合があります。

ZIP の SHA-256 を配布者から別の信頼できる経路で受け取り、展開前に手元のハッシュと照合してください。macOS は `shasum -a 256 ZIPファイル名`、Linux / WSL は `sha256sum ZIPファイル名`、Windows PowerShell は `Get-FileHash ZIPファイル名 -Algorithm SHA256` を使います。ZIP 内の `MANIFEST.json` は各ファイルの破損確認用で、単独では配布元の真正性を保証しません。

この配布版の実行経路は **OpenCode Go の単体 Bridge** です。通常の OpenAI 接続をそのまま使う選択もできます。統合ルーターの一時起動では、本人が用意したカタログに基づき GPT と OpenCode Go などの切替も利用できます。常駐サービスは自動導入しません。対応モデルと利用条件は提供元で本人が確認してください。配布版が自動的に選択するモデルはありません。単体 Bridge 内部には後方互換の既定値がありますが、下記の起動では選んだモデルを必ず渡します。

## 1. 読み取りだけで確認する

展開先のディレクトリで、次を実行します。このコマンドは設定・鍵・認証・サービスを変更せず、推論も送信しません。ポート確認ではローカル `127.0.0.1` への TCP 接続を試みます。設定ファイルは構文と特定項目の存在だけを調べ、本文・認証情報を表示しません。

macOS / Linux（Windows の WSL 内も同じ）:

```sh
python3 scripts/portable_setup.py preflight
```

Windows PowerShell（ネイティブの環境調査のみ）:

```powershell
py -3 scripts/portable_setup.py preflight
```

`CODEX_HOME` が設定されていればそれを、なければ現在の利用者の `.codex` を確認します。結果のパスは画面に表示されるため、他人に画面を共有する前に確認してください。Node.js 22.16 以上、Python 3.11 以上、Codex CLI が必要です。不足時は各公式案内から自分で導入し、再実行します: [Node.js](https://nodejs.org/)、[Python](https://www.python.org/downloads/)、[Codex CLI](https://developers.openai.com/codex/cli/)。CLI が PATH 上にないときはインストール形式と起動方法を自分で確認してください。Codex のログインは本人が公式手順で行います。

- macOS: file 認証または macOS Keychain を使用できます。Node と Codex は同じ利用者・`CODEX_HOME` で動かします。
- Linux: 現行 Bridge は Codex の file 認証に対応します。Linux keyring は未対応です。認証保存方式を勝手に変更しないでください。
- Windows: ネイティブでの ACL と Bridge の安全性をこの配布版は自動検証できないため、起動を拒否します。WSL の Linux 環境で ZIP、Node、Python、Codex を用意し、WSL 内で再度 preflight します。Windows 側の認証情報のコピーは不要です。WSL のセットアップは [Microsoft の手順](https://learn.microsoft.com/windows/wsl/install) を参照してください。

`unsafe`、`unavailable`、既存の `bridge-portable` 設定、使用中または確認できないポートが出た場合は停止します。シンボリックリンク、ハードリンク、所有者・権限の問題を迂回したり、既存サービスを停止したりしません。ポートを変える例: `python3 scripts/portable_setup.py preflight --port 18788`。Windows、macOS、Linux の実機での配布版確認は別途必要です。preflight の OS 判定テストは実機検証ではありません。

## 2. 利用者が選んで変更を確認する

Codex に、使う提供元（通常の OpenAI 接続か、この配布版が対応する OpenCode Go）、提供元で利用できるモデル ID、`CODEX_HOME` と空いているポートを相談してください。モデル ID を勝手に決めないでください。空きポート検査はその瞬間の状態であり、起動時の競合も別途検出します。すでに使っている設定やサービスの値は表示・変更せず、必要なら該当項目の存在と変更の要否だけを示します。

OpenCode Go を選んだ場合、以下の `MODEL_ID` は利用者が確認した ID に置き換えます。モデル名は鍵ではありません。まず次でプレビューしてください。

```sh
python3 scripts/portable_setup.py preview --provider opencode-go --model MODEL_ID --port 8788
```

表示される差分は、今回だけのローカル待受と Codex CLI オプションです。元の `config.toml` は編集せず、認証や他のサービスも上書きしません。Codex 自身は通常どおり会話や履歴を `CODEX_HOME` に保存することがあります。既存のカタログ設定がある場合は互換性を確認してください。元の設定を直接編集する別の導入方法を選ぶ場合は、まず下のバックアップと復元の手順を確認し、実際に変わる項目を秘密値なしで提示し、明示的に承認してから進めてください。

## 3. 承認して起動する

プレビュー内容が意図どおりのときだけ、同じ選択で次を実行します。`YES` を入力するまで Bridge を起動しません。次に利用者本人が公式 OpenCode Go API キーを非表示入力します。キーを Codex のチャット、コマンド引数、ファイル共有、ログへ貼らないでください。キーは起動した Bridge プロセスの環境だけに渡し、配布スクリプトは保存しません。

```sh
python3 scripts/portable_setup.py run --provider opencode-go --model MODEL_ID --port 8788
```

同じ `CODEX_HOME` で本人の認証をローカル確認してから前景 Bridge を立ち上げ、`/health` を確認し、選んだモデルを指定して Codex を起動します。終了すると、この起動が作った Bridge だけを停止します。外部への推論は利用者が Codex で送信した場合に限ります。既存の会話を選択すると、その履歴も選択先へ渡る場合があります。機密情報を含む会話は送信前に本人が判断してください。

Bridge が起動しない、認証方式が非対応、または Codex がモデルを受け付けない場合は中断し、preflight と以下のローカル診断を確認します。認証内容を表示・共有しません。

```sh
node src/auth-doctor.mjs
```

元の設定へ戻すための切替操作は不要です。次回は通常の `codex` を起動してください。常駐化したい場合は利用者が OS 固有の方法と起動ユーザー・権限を別途検討します。この ZIP は macOS 向け LaunchAgent インストーラーを実行しません。

## 統合ルーターを一時的に使う

この経路は Node の既存 router を使い、受取人自身のカタログにあるモデルを Codex の一覧へ渡します。OpenAI と OpenCode Go のモデル間で切り替えられます。カタログに適合する Command Code、Ollama Cloud の手動経路も runtime に含まれますが、この簡易カタログ作成器は登録しません。それらを利用する場合は本人が互換カタログと各サービスの認証を用意し、提供元・モデル・料金を確認してください。手動提供元は本人の `CODEX_HOME` 内の非公開 `commandcode-api-key`、`ollama-api-key`、`whatstoken-api-key` を参照します。ファイルは本人が用意し、チャットに貼らないでください。WhatsToken の無料枠、自動 fallback、ライブカタログ更新、CLI モデル同期、予算超過時の自動引き継ぎはこの一時起動では無効です。これらを含む runtime 本体と設定補助は同梱されていますが、別途設定する場合は変更内容を明示承認してください。実環境での動作は未検証です。

まず本人の Codex ログインと `models_cache.json`（利用者環境のモデル情報）、OpenCode Go の利用権限・キーを用意します。生成器は本人が選んだ OpenAI モデルと、配布 seed に載る OpenCode モデルだけを使用します。下の値は例ではなく各自が確認して置き換えます。出力は既存でない本人専用ディレクトリ内の新しいファイルを選びます。生成器は一覧と保存先を表示し、`YES` を入力した場合だけ新規作成し、既存ファイルは上書きしません。設定や認証はコピーしません。

```sh
node scripts/portable_catalog.mjs /PATH/TO/models_cache.json /PRIVATE/NEW/catalog.json OPENAI_MODEL_IDS OPENCODE_MODEL_IDS
```

モデル ID はそれぞれカンマ区切りです。OpenAI の ID は本人の cache に、OpenCode の ID は `src/models.json` に存在する必要があります。少なくとも各1つが必要です。生成されるカタログにはモデル情報と指示が含まれ得るため、本人が管理し、共有前に内容を確認してください。すでに互換性のある本人の統合カタログがある場合はそれを選べます。カタログは本人所有の非公開通常ファイルである必要があります。

次の `MODEL_SLUG` はカタログ内の初期モデル（OpenCode は `opencode/` 接頭辞付き）、`SUMMARY_OPENAI_SLUG` はカタログ内の OpenAI モデルを本人が選びます。ポートは空いている値を2つ選んでください。

```sh
python3 scripts/portable_setup.py preview --provider unified --model MODEL_SLUG --summary-model SUMMARY_OPENAI_SLUG --catalog /PRIVATE/NEW/catalog.json --port 8790 --bridge-port 8788
python3 scripts/portable_setup.py run --provider unified --model MODEL_SLUG --summary-model SUMMARY_OPENAI_SLUG --catalog /PRIVATE/NEW/catalog.json --port 8790 --bridge-port 8788
```

実行直前に `YES` を要求し、OpenCode がカタログに含まれる場合はキーを非表示入力します。router と Bridge の間は、この起動だけのランダムな認証値で保護し、ファイルや Codex に渡しません。両プロセスは前景セッションに付随し、終了時に今回の子プロセスだけを停止します。Codex の CLI オプションでカタログ・ルーター・初期モデルを指定し、既存 config は編集しません。利用者の `CODEX_HOME` は通常どおり使われ、Codex は履歴を保存することがあります。router は本人の既存認証や履歴設定を参照することがあります。

送信先は選択したルートに応じ OpenAI（ChatGPT または API）、OpenCode Go `https://opencode.ai`、Command Code `https://api.commandcode.ai`、Ollama Cloud `https://ollama.com`、WhatsToken `https://www.whatstoken.ai` です。利用者が送った内容や履歴がその提供元に渡り、料金が発生する場合があります。長い履歴や圧縮の処理では、選択した OpenAI 要約モデルへ内容が追加送信され、追加費用が発生する場合があります。キーはチャットに渡さず、各提供元の認証方法と通信先、課金を事前に確認してください。カタログに不要な提供元を入れないでください。ネットワーク・有料推論・実 OS での動作は未検証です。

## バックアップと復元

この起動経路は `config.toml` と既存認証を編集しません。それでも編集を伴う別の方法を選ぶ前には、Codex と設定を編集する処理を終了し、preflight で対象の `CODEX_HOME` とファイルの安全性を確認してください。本人だけが読める保存場所に `config.toml` のコピーを作り、コピー先が既存ファイルやリンクでないこと、コピー後の内容が原本と一致することをローカルで確認します。認証ファイルや鍵はバックアップや共有に含めないでください。設定本文・差分に秘密が含まれる可能性があるのでチャットやログへ表示しません。

復元する場合は、現在の設定を別名で保全してから、保存した設定を元の `config.toml` に戻します。復元先とバックアップの所有者・権限・通常ファイルであることを確認し、元の設定を編集した他の処理がないこと、復元対象とその後の変更を本人が確認・承認してから行います。ファイルの差分に秘密がある場合は値を共有しないでください。リンク、他人が書けるディレクトリ、不明な権限、他の変更が検出された場合は停止します。復元後は preflight を再実行してください。
