# 読み上げ（TTS）の中継

アプリが返答を読み上げる `/v1/audio/*` を、Rialto 経由で TTS サーバー（Irodori-TTS など）へ中継する。

以前はエッジが `/v1/audio/*` を TTS サーバーへ直接振り分けていた。そのため、パスを知っていれば誰でも読み上げを使えた。
Rialto を通すと、補完と同じ `/v1` のトークン検査を通るようになる。アプリがすでに持っているアクセストークンが、そのまま読み上げの鍵になる。

## 中継するパス

| パス | 中継先 |
| --- | --- |
| `POST /v1/audio/speech` | `<RIALTO_TTS_URL>/v1/audio/speech` |
| `GET /v1/audio/voices` | `<RIALTO_TTS_URL>/v1/audio/voices` |

- 中継するのはこの 2 つだけ。TTS サーバーのほかのパスと、TTS サーバー自身のアドレスは外から見えない。
- クライアントが送ったトークンは TTS サーバーへ渡さない。
- 上流が返したステータスと本文はそのまま返す。「その声はない」のような上流のエラーも、アプリにそのまま届く。
- リクエスト本文の上限は 64 KiB。超えると `413` を返し、TTS サーバーには送らない。
- 上流の応答を待つのは最大 120 秒。

## トークンとプラン

- どちらのパスも `/v1/models` と同じ扱いで、完了リクエストのサーフェスではない。
- エンドポイントを絞ったトークンでも使える。アプリ端末のトークンは `/v1/responses` と `/v1/chat/completions` に絞られているが、読み上げはできる。
- プランの利用枠（[plans.md](plans.md)）には数えない。数えると、返答 1 回を読み上げるたびに枠を 2 回分使うことになる。

## 設定

TTS サーバーは Rialto と同じ `compose.yaml` で動かす前提。宛先は環境変数 `RIALTO_TTS_URL` で、サービス名で指定する。

```yaml
services:
  rialto:
    environment:
      RIALTO_TTS_URL: http://irodori-tts:8000   # ポートは TTS サーバーに合わせる
  irodori-tts:
    # TTS サーバーのイメージと設定。ports で公開する必要はない。
```

- 未設定のあいだ、`/v1/audio/*` は `503` を返す。
- TTS サーバーに届かないときは `502` を返す。
- 変更は Rialto コンテナの再起動で反映される。

この値は、データベースの `DATABASE_URL` や `REDIS_URL` と同じく、コンテナ同士の配線にあたる。そのため管理画面ではなく compose で持つ。

## 切り替えの順番

1. `RIALTO_TTS_URL` を入れて Rialto をデプロイする。
2. エッジ（トンネル）で `/v1/audio/*` を TTS サーバーへ振り分けている設定を外し、`/v1/*` と同じく Rialto へ送る。
3. TTS サーバーの `ports` の公開をやめる。こうすると、Rialto を経由しない入口が残らない。

アプリ側は、`/v1/audio/voices` にも `/v1/audio/speech` にもアクセストークン（`Authorization: Bearer`）を付けて送る必要がある。
