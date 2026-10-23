# remote compaction v2のOpenCode経路（Issue #57）

## 原因

Codex 0.164.0はremote compaction v2で通常の `/v1/responses` を呼び、入力末尾の `compaction_trigger` に対して `compaction` itemを正確に1件要求する。OpenCodeのChat変換はこの項目を通常メッセージとして扱い、モデルが説明と回答を返すため、compaction itemが0件となり停止していた。

公式の圧縮API仕様も、compaction応答に1件の `compaction` itemを含む形式を定義している。
https://developers.openai.com/api/reference/resources/responses/methods/compact

## 修正

- `compaction_trigger` を含むOpenCode Chat要求だけを、カタログ上のOpenAI要約モデルへ振り分ける。
- 通常会話、モデル選択、履歴、ツール定義は変更しない。
- OpenAI要約モデルがない場合は、OpenCodeへ誤送信せずHTTP 422で停止する。
- 圧縮後の履歴は従来どおりOpenAIの暗号化itemとして保持し、次のDeepSeek要求で既存の引き継ぎ処理を使う。
- メトリクスへ `requested_provider` と `remote_compaction_fallback=openai` を記録する。本文や認証は記録しない。

## 検証

- 修正前相当の経路では、DeepSeekがcompaction itemを返せず、利用者画面と同じ「0 from 2 output items」になった。
- 修正後に追加したNode試験2件は成功。圧縮要求はOpenAIの `gpt-test` にだけ到達し、入力の `compaction_trigger` を保持した。要約モデル不在時は0要求で422。
- 実Codex 0.164.0 app-server＋模擬上流で、DeepSeek選択中に2回目のremote compactionを実行。要求はOpenAIへ到達し、その後同じスレッドでDeepSeekの回答が完了した。OpenCodeへ `compaction_trigger` は送られていない。
- 一時要約失敗→1回再試行→圧縮→DeepSeek回答→別の圧縮→もう一度DeepSeek回答→resumeを確認。
- 連続要約失敗では2試行で停止し、OpenCodeへ要求しない。
- `python3 scripts/run_test_inventory.py --output test-results`: Node126 / Python81、全207件成功。
- 既存の実app-server＋実Chat bridge 27要求、ツール回復8要求も成功。shell構文・Pythonコンパイル・diff check成功。

## 限界

実顧客会話を外部へ再送する試験はしていない。実API追加0要求。過去に停止した元スレッドはそのまま変更せず、同じ1685項目を持つforkを別途作成済み。修正版は次のremote compaction要求から適用される。Codex本体の将来バージョンでも同じwire形式が続く保証はない。
