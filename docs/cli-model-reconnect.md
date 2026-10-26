# 既存画面のモデル一覧復旧（Issue #120）

## 再現した状態

実Herdr画面でfooterは `opencode/deepseek-v4.1-flash high`、`/model`はGPTの7件だった。
画面は修正済みlauncherを通らず、以前から残っていたシェルから共有daemonへ接続していた。
新しいシェルでの表示成功だけでは、この画面の復旧を確認したことにならない。
チャットが答える子エージェント用モデル一覧も、TUIの選択一覧とは別である。

## 起動の修正と会話の保持は別に確認する

- `~/.zshenv`の管理関数は、新しいシェルで有効になる。既存シェルには自動で読み込まれない。
- 通常の`codex`/`codex resume`が安定入口から`--no-daemon`付きで実行されたことを確認する。
- 保存済み会話でも共有serverがwriterを保持していると、専用serverで「This conversation is open in another app」と表示される。
- Codex 0.164.0の共有serverは、未購読かつidleになってから標準1800秒で会話をunloadする。これは推論の再試行時間ではない。
- 起動済み会話へのconfig overrideは無視されるため、短いunload設定を後付けして即解除できるとは扱わない。

参照: [CLIのno_daemon](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/tui/src/cli.rs)、[標準1800秒の設定](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/config/mod.rs)、[idle時のunload](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/thread_lifecycle.rs)。

## 今回の承認付き移行

ユーザーが対象会話の一時archive→unarchiveを承認した後、次を行った。
これは一律に全会話へ適用する処理ではない。archiveは子孫にも影響するため対象を先に確認する。

1. 対象がidle、保存実体あり、子孫0件、未archive、選択モデルがDeepSeekであることを確認。
2. rolloutと照合情報を本人専用backupへ保存。会話本文はGitHubやPKBへ転記しない。
3. 対象TUIだけを切断。共有daemonや他のpaneは停止しない。
4. 公式`thread/archive`の後、`thread/unarchive`を実行。解除に失敗したらそこで止め、同じIDの復旧を優先する。
5. archived=false、同じID・モデル・high、rolloutのSHA-256とバイト数が移行前と一致することを確認。
6. 既存シェルへ管理関数を読み込み、追加flagなしの`codex resume <ID>`で再開。
7. 対象の実`/model`でOpenCode DeepSeek (current)、GPT、Command Code、Ollamaが表示された。
8. 選択を変更せず画面を戻し、退避した未送信入力を復元。

今回の保存済み会話の同一ID移行は成功した。以前の未保存live IDについて、同じ結果を保証するものではない。
検証中に推論要求やダミー発言は送っていない。初回turn前の会話を別IDに置換せず、ロック自体の保護機構は無効化していない。

## 再発確認

新しいシェルの通常起動だけでなく、実際に困っているpaneで確認する。
footer、`/model`、選択中ID、実プロセスの起動引数を別々に検証する。
接続が直ったことを、AIがチャットで答えるモデル一覧だけから判定しない。
