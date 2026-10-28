# Issue #145: 音声だけReconnectingになる場合の切り分け

## 原因

Codexの音声入力(Realtime WebSocket)は `experimental_realtime_ws_base_url` を使い、未設定なら
**選択中providerのbase URL**(組み込み`openai`なら`openai_base_url`)から `ws(s)://…/v1/realtime` を組み立てる。
テキスト用の `openai_base_url` をローカルproxy/routerへ向けると、音声もそこへ送られる。
Bridgeのrouterは `426 Upgrade Required` を返し、opencodex等のproxyもRealtimeを実装していなければ接続できない。
結果として音声UIは `Reconnecting...` のまま止まる。

## Bridgeの扱い

統合router(`unified_config.py on` / `normal-on`、`switch.sh on|off|repair`)は、テキストをrouterへ向ける時だけ
Realtimeを次のように扱う。変更前の値は `unified-router-state.json` の `realtime` に、未設定・空・値の区別を保って保存する。

| 変更前の `experimental_realtime_ws_base_url` | on / repair | off |
|---|---|---|
| 未設定 | 公式 `wss://api.openai.com/v1` を設定し、Bridge所有として記録 | Bridgeの値のままなら削除して未設定へ戻す |
| Bridgeが設定した値 | 同じ値を保持(冪等) | 同上 |
| 公式URL(`api.openai.com`) | 本人設定として保持 | 変更しない |
| 公式以外のリモートURL | 警告して保持 | 変更しない |
| 他ツールのloopback URL(例 `http://127.0.0.1:10100/v1`) | **停止**。ファイルは変更しない | 変更しない |
| BridgeのrouterURL(8788/8790/8791) | 停止。行の削除を案内 | 変更しない |
| 空文字・不正URL | 停止。行の削除を案内 | 変更しない |
| 有効化後に本人/他ツールが変更した値 | 上表で再判定 | 警告して保持 |

- 他ツールのproxyがRealtimeを実装していると確認済みの場合だけ、`CODEX_BRIDGE_KEEP_REALTIME_OVERRIDE=1` を付けて実行すると保持して続行する。
- stateだけ書いて設定の置換前に中断した場合、またはoff後にstateが残った場合も、再実行で同じ結果になる。
- 旧版のstate(`realtime`なし)は `switch.sh repair` で記録と公式URLの設定を補う。

## 診断(設定は変更しない)

```bash
python3 scripts/realtime_config.py doctor          # 設定だけを確認
python3 scripts/realtime_config.py doctor --probe  # 接続先がloopbackの時だけ認証なしhandshakeを送る
```

`text_base_url`(テキスト)と `realtime_target`(音声)を別々に表示する。`realtime_target` がloopbackで
proxyがRealtimeを実装していない場合、空・不正値、Bridgeのstate記録不足を `problems` に出し、終了コード1を返す。
URLの認証情報・query・fragmentは出力しない。`--probe` は音声や認証情報を送らない。

## 復旧手順

1. `python3 scripts/realtime_config.py doctor` で `realtime_setting.state` と `realtime_target` を確認する。
2. `loopback-foreign` の場合、そのproxyを入れたツール(例: opencodex)のCodex統合・自動起動を無効にするか、
   `config.toml` の `experimental_realtime_ws_base_url` 行を削除する。Bridgeはこの行を自動で消さない。
3. 統合routerを使う場合は `./scripts/switch.sh repair` で公式Realtime URLを記録・設定する。
4. Codexアプリを再起動し、Voice/Dictateの初回接続を確認する。起動済みのセッションは旧設定のまま動くことがある。

Realtime proxyの実装、外部モデルへの音声送信、公式以外への自動fallbackは対象外。
