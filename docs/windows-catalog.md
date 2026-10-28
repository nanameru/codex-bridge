# Windowsカタログ診断・移行（Issue #143）

Windowsの旧 `codex-bridge-local` コピーでは、`config.toml` の `model_catalog_json` がOpenCode専用の `model-catalog.json` を指し、Codexの組み込みモデル一覧を置き換えていました。その結果、`gpt-6.1-sol` などOpenAI公式モデルが一覧から消えます。

`scripts/windows/catalog-doctor.ps1`（本体は `scripts/catalog_doctor.py`）で、状態の診断と、組み込み一覧を壊さない動的カタログ（`codex-live`）への移行・復元を行います。

既存Bridgeを残したまま、公式モデル対応routerの準備とカタログ移行をまとめて行う場合は、`scripts/windows/catalog-setup.ps1` を使います。

## 前提

- このリポジトリの最新版（`scripts/live_catalog.py` / `scripts/unified_config.py` / `src/live-catalog.mjs` を含む）
- Node.js 22.16以上
- Python 3.11以上（`py -3` / `python` / `python3` の順で探します）
- 既存Bridgeが `127.0.0.1:10100` で起動していること（変更する場合は `-BridgePort` を指定）
- 適用時のみ、動的カタログ対応の最新routerが同じ `CODEX_HOME` で起動し、Codexの認証を確認できていること（`/health` の `live_catalog: true` と `catalog_auth`）

## 使い方

### 一括セットアップ（推奨）

```powershell
cd C:\Users\User\Projects\codex-bridge-issue143
powershell -ExecutionPolicy Bypass -File scripts\windows\catalog-setup.ps1 -BridgePort 10100
```

このスクリプトは、既存Bridgeのhealth確認、統合カタログの生成、routerの起動、`catalog_auth.ready` の確認、バックアップ付きの `apply` を順番に行います。既に動的カタログ対応routerが `8790` で動いている場合は再利用します。完了後、Codexデスクトップをタスクトレイまで完全終了してから起動し直し、モデル一覧を確認してください。

### 個別操作

```powershell
# 読み取りのみの診断（既定）
powershell -ExecutionPolicy Bypass -File scripts\windows\catalog-doctor.ps1
# JSONで出力
powershell -ExecutionPolicy Bypass -File scripts\windows\catalog-doctor.ps1 -Json
# 移行（旧OpenCode専用カタログのときだけ変更）
powershell -ExecutionPolicy Bypass -File scripts\windows\catalog-doctor.ps1 -Action apply -Port 8790
# 移行前へ戻す
powershell -ExecutionPolicy Bypass -File scripts\windows\catalog-doctor.ps1 -Action restore
```

`-CodexHome` を省略すると `CODEX_HOME`、無ければ `%USERPROFILE%\.codex` を使います。macOS/Linuxでは `python3 scripts/catalog_doctor.py [diagnose|apply|restore]` で同じ処理です。

## 診断結果

| 状態 | 意味 |
| --- | --- |
| `legacy_opencode_only` | 固定カタログに公式モデルが0件。Issue #143の原因で、`apply` の対象 |
| `unified` / `native_only` | 公式モデルを含む固定カタログ。自動変更しません |
| `builtin` / `dynamic` | 固定カタログ無し / `codex-live` の動的カタログ |
| `unknown` | カタログを読めない等。自動変更しません |

公式モデルかどうかは、`opencode/` などの接頭辞が無く、かつ `models_cache.json`（公式一覧）に載っているかで数えます。接頭辞の無い旧OpenCodeカタログ（`deepseek-v4.1-flash` など）も公式一覧と照合して `legacy_opencode_only` と判定します。`src/make-catalog.mjs` が生成した項目（Bridge独自の `base_instructions` 付き）は、`gpt-6-luna` のように公式と同名でもOpenCodeとして数えます。公式一覧のキャッシュが無いときは接頭辞だけで数えるため、接頭辞の無いカタログは `native_only` となり自動変更しません。

`gpt-6.1-sol` の判定は、Codexが公式APIから取得した `models_cache.json`（公式一覧）と比較して区別します。

| 判定 | 意味 |
| --- | --- |
| `hidden_by_catalog` | 公式一覧にはあるが、固定カタログの置換で消えている（移行で解決） |
| `not_in_official_list` | 公式一覧のキャッシュにも無い。プラン/アカウント未提供か、キャッシュが古い |
| `unknown_no_cache` | キャッシュが無く判定できない。Codexを一度起動してから再診断 |
| `listed` | 一覧にはある。実プランで送信できるかは一覧では判定できないため、実際に1回送信して確認 |

## 安全性

- `diagnose` は何も書き込みません（ロックファイルも作りません）。`auth.json` は読みません。出力は状態・件数・モデル名・カタログのパスだけで、provider設定の値は表示しません。
- `apply` は変更前に `config.toml.issue143-<日時>.bak` へ元のバイト列をそのまま保存し、`catalog-migration-state.json` にハッシュを記録します。CRLFの改行は維持します。
- 2回目以降の `apply` は `unchanged` を返します。移行後に設定が編集されていれば、再適用も復元も拒否します。
- BOM付き・リンク・読めないカタログ・既存の独自 `codex-live`・他ツールの復元情報（`live-catalog-state.json` / `unified-router-state.json`）・router未起動のときは何も書きません。
- 移行後の一覧が0件にならないよう、`apply` の前にrouterの `/health` の `catalog_auth` を確認します。routerが報告する `codex_home`（`CODEX_HOME` の実パスのSHA-256）が同じで、`ready`（routerがそのCODEX_HOMEのCodex認証を確認できる）が真のときだけ変更します。古いrouter・別のCODEX_HOME・認証を確認できないrouterでは何も書きません。どちらの側も秘密値は読み書き・表示しません。
- 実行中のCodexデスクトップ/CLIは停止しません。反映には全て終了してから再起動してください。Bridge停止時の自動復旧は対象外です。

## 検証

```sh
python3 -m unittest discover -s test -p test_catalog_doctor.py
node --test test/windows-auth.test.mjs
```

CIの `windows-latest` ジョブで、Windows PowerShell 5.1の構文検証（`catalog-doctor.ps1` / `catalog-setup.ps1`）、本人認証の読み取り分岐、PowerShell経由の診断とrouter未起動時の不変更を確認します。Windowsの実端末への適用と、適用後のモデル一覧・実送信はこのリポジトリのCIでは確認できません。
