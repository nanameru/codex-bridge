# Windowsカタログ診断・移行（Issue #143）

Windowsの旧 `codex-bridge-local` コピーでは、`config.toml` の `model_catalog_json` がOpenCode専用の `model-catalog.json` を指し、Codexの組み込みモデル一覧を置き換えていました。その結果、`gpt-6.1-sol` などOpenAI公式モデルが一覧から消えます。

`scripts/windows/catalog-doctor.ps1`（本体は `scripts/catalog_doctor.py`）で、状態の診断と、組み込み一覧を壊さない動的カタログ（`codex-live`）への移行・復元を行います。

## 前提

- このリポジトリの最新版（`scripts/live_catalog.py` / `scripts/unified_config.py` / `src/live-catalog.mjs` を含む）
- Python 3.11以上（`py -3` / `python` / `python3` の順で探します）
- 適用時のみ、動的カタログ対応のrouterが起動していること（`/health` が `live_catalog: true`）

## 使い方

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

`gpt-6.1-sol` の判定は、Codexが公式APIから取得した `models_cache.json`（公式一覧）と比較して区別します。

| 判定 | 意味 |
| --- | --- |
| `hidden_by_catalog` | 公式一覧にはあるが、固定カタログの置換で消えている（移行で解決） |
| `not_in_official_list` | 公式一覧のキャッシュにも無い。プラン/アカウント未提供か、キャッシュが古い |
| `unknown_no_cache` | キャッシュが無く判定できない。Codexを一度起動してから再診断 |
| `listed` | 一覧にはある。実プランで送信できるかは一覧では判定できないため、実際に1回送信して確認 |

## 安全性

- `auth.json` は読みません。出力は状態・件数・モデル名・カタログのパスだけで、provider設定の値は表示しません。
- `apply` は変更前に `config.toml.issue143-<日時>.bak` へ元のバイト列をそのまま保存し、`catalog-migration-state.json` にハッシュを記録します。CRLFの改行は維持します。
- 2回目以降の `apply` は `unchanged` を返します。移行後に設定が編集されていれば、再適用も復元も拒否します。
- BOM付き・リンク・読めないカタログ・既存の独自 `codex-live`・他ツールの復元情報（`live-catalog-state.json` / `unified-router-state.json`）・router未起動のときは何も書きません。
- 実行中のCodexデスクトップ/CLIは停止しません。反映には全て終了してから再起動してください。Bridge停止時の自動復旧は対象外です。

## 検証

```sh
python3 -m unittest discover -s test -p test_catalog_doctor.py
```

CIの `windows-latest` ジョブで、Windows PowerShell 5.1の構文検証、同テスト、PowerShell経由の診断と router未起動時の不変更を確認します。
