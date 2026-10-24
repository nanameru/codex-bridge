# OpenCodeモデルの自動反映

OpenCode Goが提供するモデルを、公開時刻に依存せず取得する。新モデルごとのソース変更やrouterの再起動は不要。

- 正本: `https://opencode.ai/inference/go/v1/models`。既存のGoキーだけをこの公式originへ送る。
- 能力情報: models.devのopencode-go。画像対応、コンテキスト長、推論レベルを検証して適用する。補助情報未掲載でも提供APIにあるIDは保守的設定で追加する。
- GPT: 呼出元の既存Codex認証とバージョンで公式Codexモデルカタログを取得し、元のinstructionsや能力設定を保持する。
- クライアントへは認証付き`/codex/models?client_version=...`でCodex形式を返す。API形式の`/v1/models`とは別。

Codexの起動・モデル一覧取得時の更新機構を使う。中継側も5分キャッシュし、同時取得は共有する。能力情報は通常1時間保持し、新ID検出時は更新を試す。取得失敗後は30秒間再試行を抑制し、同じ認証・バージョンの直前成功一覧を保持する。サーバー内キャッシュはメモリ上であり、再起動後の初回取得には接続が必要。

正常な全件検証後に一覧と中継ルートを一括更新する。進行中の推論は中断しない。提供終了モデルは一覧から外し、後続の明示要求はエラーにする。別モデルへ黙って切り替えない。

routerだけが再起動し、クライアントのキャッシュに新モデルが残っている場合は、未知のIDを拒否する前に呼出元のversionと認証でカタログを確認する。実際に提供中のモデルだけをルートへ反映し、未提供IDの要求は引き続き拒否する。

## 適用と復元

動的カタログ対応routerを反映した後に実行する。

```bash
python3 scripts/live_catalog.py
python3 scripts/live_catalog.py --apply
# 必要時の復元。適用後に別の編集がある場合は停止する。
python3 scripts/live_catalog.py --apply --restore
```

固定`model_catalog_json`を外し、`codex-live` providerへ移行する。`requires_openai_auth=true`で既存のChatGPT認証を使用し、推論先とカタログ先だけを本人用loopback routerへ向ける。モデル選択や他の設定は保持する。設定原本は`~/.codex/live-catalog-state.json`へ0600で保存し、競合や独自の同名providerは上書きしない。

既に起動している常駐app-serverは古い設定を保持する。CLIだけを終了して通常の`codex resume`で開き直しても、同じ常駐サーバーに再接続するため反映されない場合がある。

他のチャットを止めずに新設定で再開するには、対象CLIを終了して次を実行する（Codex 0.164.0で実機確認済み）。既存スレッドの履歴を使い、新しい組み込みapp-serverで起動する。

```bash
codex resume <thread-id> --no-daemon
```

通常の起動方法にも反映したい場合は、接続中の全チャットの作業が終わってから`codex app-server daemon restart`で常駐サーバーを一度再起動し、CLIを再開する。この操作は接続中の他チャットにも影響するため、設定適用ツールから自動では実行しない。以後、新モデル追加ごとの再起動は不要で、TTL後のモデル一覧取得が新モデルを反映する。明示的に固定カタログを指定するprofileや起動引数は、その設定が優先される。

動的取得後の`models_cache.json`はGPTとOpenCodeの混在一覧になる。旧固定カタログの準備処理でもOpenCode項目をGPTとして取り込まず、それぞれの元一覧から再生成する。GPT項目のないキャッシュや不正なIDは引き続き拒否する。

モデルの公開時刻や発表日でスケジュールしない。公開元→Goの提供開始→能力情報の掲載には時間差があるため、実際の提供APIを確認する。全モデルの実推論成功を一覧掲載だけで保証するものではない。

## 検証

```bash
node --test test/live-catalog.test.mjs
python3 -m unittest discover -s test -p test_live_catalog.py
python3 test/live-catalog-app-e2e.py
```

実app-serverと模擬提供元で、一覧取得、新ID追加、同じプロセスでのTTL後の反映、新モデルの模擬応答、native圧縮、再圧縮、再起動resumeを検証する。APIキー/ChatGPT認証の取り違え、他accountやバージョンのキャッシュ混用、未認証取得、件数/容量/ID不正も検証する。

実CLIの検証はapp-serverの`model/list`検証と区別する。隔離CODEX_HOMEの古い合成スレッドを`--no-daemon`でresumeし、実際に`/model`を開く。模擬提供元では追加したFuture Test、本番カタログではKimi K3.1 Proの表示を確認した（0.164.0）。一覧表示だけの検証であり、Kimiへの実推論やユーザーの実スレッドへの送信は行っていない。
