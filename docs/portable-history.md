# GPTとOpenCodeで使い回せる履歴の導入仕様

CodexのハーネスとChatGPTログインを維持し、GPTとOpenCode APIのモデルを同じチャットで切り替えるための仕様。今後の圧縮はCodex標準の文章要約へ揃える。既存の暗号化圧縮の移行、画像サイズの見積もりは別工程として扱う。

## 分解した部品と採用方針

| 部品 | 採用する仕組み | このリポジトリでの実体 | 状態 |
| --- | --- | --- | --- |
| 推論先の選択 | モデル名でGPT/OpenCodeを振り分ける | `src/model-router.mjs` | 既存 |
| API・ツールの変換 | ResponsesとChat Completionsの差を吸収する | `src/tool-adapter.mjs`、`src/codex-bridge.mjs` | 既存 |
| 持ち運べる圧縮 | Codex標準local compactionで文章要約を保存する | `scripts/portable_history.py` | 本変更で追加 |
| 旧履歴の送信時引き継ぎ | 本人の元ログを選択モデルで再要約、または明示的にOpenAIを使用 | `src/rollout-history.mjs`、`src/history-mode.mjs` | [履歴モード](history-modes.md)。元ログの条件を満たす場合のみ。原本や保存済み暗号履歴は書換えない |
| 入力の計測 | 文章トークン、画像、転送bytesを別々に評価する | `src/model-router.mjs`の現行見積もりを置換する | 未実装 |
| ツール出力の整理 | 重複・長いログを削減し、必要時に原本へ戻れるようにする | Headroom等は後段で比較する | 今回は依存追加しない |

local compactionはローカルLLMの意味ではない。選択中のモデルへ通常の推論要求で要約を依頼し、Codexが文章を履歴として保存する。圧縮そのものの推論コストは発生するが、平文要約を持つ会話では提供元切替のためだけの追加GPT要約を避けられる。隠れた推論の内容やモデル固有の内部状態が完全移行するわけではない。

## OSSから取り込む考え方

参照日は2026-10-23。リンクは調査時のrevisionへ固定した。ソースコードは転載せず、Codexの公開設定を使う独立した小さな実装にした。

| OSS / ライセンス | 確認した部品 | 取り込む部分 | 取り込まない部分 |
| --- | --- | --- | --- |
| [OpenCodex / MIT](https://github.com/lidge-jun/opencodex/blob/83ec4f75a4cc97030c2fa7857e05e2ce222f376f/docs-site/src/content/docs/guides/codex-integration.md#client-side-compaction-opt-in) | 専用custom providerでCodexに文章圧縮を管理させる設定 | 新規会話をcustom providerへ揃える設計 | GUI、アカウントプール、独自暗号形式、履歴DBの書換え |
| [Codex Router / MIT](https://github.com/duolahypercho/codex-router/blob/0a0fdce15b8325b10dd3f187c0acf1beed50dda4/docs-site/src/content/docs/getting-started/how-it-works.md#transport-and-compaction) | 認証境界、外部API変換、参照元を持つ圧縮checkpoint | GPT認証と外部認証の分離、原本と要約を区別する考え方 | LiteLLMの追加、独自`kcr2`形式。既存OpenAI暗号化圧縮の万能復号は提供しない |
| [Headroom / Apache-2.0](https://github.com/headroomlabs-ai/headroom/blob/e995eb9f1dacac7ed548758406de6c1508caef95/README.md) | ツール出力等の入力圧縮 | 入力肥大化の対策を独立部品として評価する考え方 | 今回の画像413がインストールだけで直るとは扱わない。暗号化履歴の復号にも使わない |

公式根拠: [Codexの設定](https://learn.chatgpt.com/docs/config-file/config-reference)、[0.163.0のlocal compaction](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/compact.rs)、[APIのopaque compaction仕様](https://developers.openai.com/api/docs/guides/compaction)。

## 新しい会話の経路

```text
Codex（会話・ツール・resume・文章圧縮）
  └─ codex-bridge provider（requires_openai_auth=true）
       └─ 共通router
            ├─ GPT → 既存のChatGPT/Codex認証でOpenAIへ
            └─ OpenCodeモデル → 変換bridge → OpenCode API

圧縮時: 選択中モデルに要約を依頼 → 文章をCodex履歴へ保存
切替時: その文章＋直近の会話・ツール結果を選択先へ送信
```

要約を自前で暗号化しない。暗号化文字列をJSONの参照IDへ置き換える独自ストアも追加しない。ツール定義、会話ID、ユーザーの権限を圧縮のために変更しない。

## 使えるコマンド

前提: Python 3.11以上、Codex 0.162.0以上、既存の保護版router（8791）とbridge（8788）、統合カタログが設定済み。既定のprofileなし起動を対象とする。個別profileでproviderを上書きする起動には、この設定が適用されないことがある。

まず変更なしで確認する。

```bash
python3 scripts/portable_history.py
```

適用コマンドは、Codex版・両サービスの保護状態・カタログ一致を非推論リクエストで確認し、設定をバックアップしてから書き換える。

```bash
python3 scripts/portable_history.py --apply
```

変更するのは次の設定だけ。既定モデル、他profile、他のcapability、他のヘッダーは保持する。

```toml
model_provider = "codex-bridge"

[model_providers.codex-bridge.capabilities]
remote_compaction = "unsupported"
```

旧`x-codex-bridge-direct`ヘッダーがあれば除去する。これにより旧routerでも統合OpenCodeモデルが共通変換経路を通り、native GPTは引き続きOpenAIへ転送される。ChatGPT認証情報は変更しない。

コマンドはサービスや開いているチャットを再起動しない。次にCodexを起動して新規チャットを作り、その会話でGPT/OpenCodeを切り替える。`codex resume`は、その新規チャットについて同じproviderと文章要約を使う。

### 復元

適用結果の`backup`に表示されたパスを使う。下記のパスは例なので実際の値に置き換える。

```bash
python3 scripts/portable_history.py --restore /path/to/CODEX_HOME/config.toml.bak.portable-history.ACTUAL
python3 scripts/portable_history.py --restore /path/to/CODEX_HOME/config.toml.bak.portable-history.ACTUAL --apply
```

適用後に設定が変わっていたら復元を拒否する。ユーザーの後続変更をバックアップ全体で上書きせず、差分を確認して対象設定だけ戻す。復元操作自体もバックアップする。

## 既存の暗号化済み会話

| 入力状態 | 方針 | 制約 |
| --- | --- | --- |
| 文章の要約と通常会話だけ | そのまま変換して送る | 送信先の入力上限・画像対応を確認 |
| 元のユーザー/assistant/ツール記録が残る | 原本を壊さず移行用の履歴を構成する案を評価 | rollback、重複、ツール対応関係を復元する必要がある。全ログを単純結合しない |
| 暗号化圧縮にしか残っていない文脈 | 元のGPTで一度だけ文章化する | 追加推論が必要。全文復号や完全復元ではない |
| 読めない暗号化履歴が残り、元の提供元も利用不可 | 移行を止め、不足範囲を示す | 暗号化itemを黙って削除して継続しない |

このコマンドは既存スレッドのproviderやrolloutを変更しない。設定を切り替えても、既に`openai` providerで保存されたスレッドが文章圧縮へ自動移行するわけではない。現在の引き継ぎ処理は旧会話向けフォールバックとして残す。

`thread/resume.history`は0.163.0のソースで不安定かつCodex Cloud用と明記されており、本設計の移行用公開APIにはしない。

## 画像413の別工程

現在の`estimateInputTokens`はJSON全体を文字数から推定するため、画像のBase64を文章として数える。次の変更を独立して実装する。

1. 文章・ツールschemaは文章として数える。
2. `input_image`等の構造化された画像は画像として評価する。任意の文章中のBase64らしい文字列まで無条件に除外しない。
3. 画像の対応可否、サイズ・解像度・枚数と、HTTP転送byte上限を別々に確認する。
4. 元画像・最新ツール結果を黙って削除せず、使えない場合は理由を返す。
5. 大きな画像3枚、画像＋長い文章、未知形式、ツール結果内画像で回帰テストする。

Headroom等を追加する前に、誤った画像計数を直す。今回の設定コマンドはこの413を修正しない。

## 検証と実装順

| 順序 | 作業 | 完了の判定 |
| --- | --- | --- |
| 1 | 標準文章圧縮の設定 | previewで無変更、apply/restoreが安全、選択モデルを保持 |
| 2 | 模擬上流で実Codexを動かす | GPT→圧縮→OpenCode→圧縮→GPT→再起動/resume→OpenCodeが成功。文章要約を2件保存 |
| 3 | 画像の入力計数を修正 | 構造化画像のBase64を文章扱いせず、byte上限は維持 |
| 4 | 旧会話の一度限りの移行 | 原本保全、不足範囲・要約の省略を明示して移行先を検証 |
| 5 | 入力圧縮OSSの追加を判断 | 入力削減・文脈保持・運用負担を同一fixtureで比較 |

本変更で1・2を実装し、3〜5を後続工程へ分離した。実モデル全組合せの品質は模擬応答だけでは保証できない。

```bash
python3 -m unittest discover -s test -p 'test_portable_history.py'
python3 test/codex-portable-e2e.py
python3 test/codex-portable-e2e.py --start-opencode
python3 test/codex-portable-e2e.py --tools
python3 test/codex-portable-e2e.py --tools --start-opencode
```

実Codex E2Eは本人のモデルカタログを一時ディレクトリへコピーするが、認証は偽物、上流はローカルの模擬APIを使う。実APIの利用枠を消費しない。CIの通常ゲートはPython設定テストを実行し、実Codex E2EはCodexバイナリとカタログがある環境で別実行する。

### 追加の異常系・往復テスト

設定テストは、全33外部モデルとGPTの選択保持、壊れた/空/重複/リンクされたカタログ、独自provider、未知モデル、未知ヘッダー、不正な設定型、公開権限、hardlink、古いCodex、サービス異常、カタログ不一致を検証する。適用前・バックアップ後の競合、書込み失敗、変更後の復元拒否、適用→復元→再適用、プレビューで秘密を表示しないことも確認する。

実Codex E2EはGPT開始/OpenCode開始とツールあり/なしの4組合せで、各4ターン・2回圧縮・再起動後resumeを実行する。通常要求が6回、ツールありは10回となり、専用の引き継ぎ要約やremote compactが追加されないことを検証する。模擬応答による通信・保存形式の検証であり、実モデルが要約から全ての細部を想起できることまでは保証しない。
