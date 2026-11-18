# 配布 ZIP の標準ランチャーを録画検証する

TC-125 の OpenCode Go 経路を、配布 ZIP のバイトを変えずに模擬上流で検証する。ハーネスはリポジトリの `test/` にあり、配布 ZIP の allowlist には含まれない。

1. Devin 側の検証用 macOS、Linux、または WSL 2 で、信頼できる Python 3.11 以上、Node.js 22.16 以上、Codex CLI を用意する。WSL ではすべて Linux 用を使う。検証環境に実アカウントの認証情報や既存のブリッジを持ち込まない。
2. macOS は `/usr/bin/sandbox-exec`、Linux / WSL はネットワーク名前空間を作成できる Bubblewrap（`bwrap`）を用意する。macOS では指定する 2 ポートを使うローカルサービスがない環境を使う。隔離を準備できない場合、ハーネスは標準ランチャーを起動する前に停止する。
3. 検証対象の ZIP を用意し、配布ビルドの記録から SHA-256 を取得する。実行の前に録画を始める。PTY があるターミナルで、PR の対象 commit をチェックアウトしたリポジトリから次を実行する。

   ```sh
   python3 test/portable_launcher_harness.py /path/to/distribution.zip \
     --sha256 '<配布ビルドの SHA-256>'
   ```

   必要に応じて `--codex /path/to/codex`、`--port 18788`、`--mock-port 18999` を指定する。ポートが競合した場合はその試行を記録し、次の試行では空いている別の 2 ポートを選ぶ。

4. ZIP 照合と模擬上流の準備が成功すると、配布版の `preflight`、`preview`、`run` が順に進む。標準ランチャーの承認プロンプトで `YES`、鍵のプロンプトで固定の合成値 `tc125-synthetic-opencode-key` を入力する。中断する場合は Ctrl+C を使う。
5. 実 Codex の最終応答 `BRIDGE_OK`、模擬上流への到達、Bridge と模擬上流の停止、`config.toml` の SHA-256 不変がそろうと `PASS` が表示される。成否にかかわらず、録画を private に保存して読み戻す。対象 commit・ZIP SHA-256・OS・時刻・成否と対応付ける。

Linux / WSL は空のネットワーク名前空間とループバックを使う。macOS は Seatbelt で外部接続を拒否し、Bridge と模擬上流の 2 つのローカルポートだけに接続する。使い捨て HOME に合成 Codex 認証を作る。テスト用 Node ラッパーは、配布版のランチャーが起動した対象 Bridge にだけ、固定のループバックの模擬上流を指定する。Codex ラッパーは標準ランチャーが渡した引数を保ち、実 CLI の `exec` と固定プロンプトを加える。

TC-125 の実環境での結果は、各録画を読戻した後に台帳へ反映する。この手順の対象は OpenCode Go の模擬上流と file 認証。
