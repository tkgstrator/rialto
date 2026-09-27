# アプリ端末の登録（App Attest）

iOS アプリが、利用者に API キーを入力させずに自分用のアクセストークンを受け取るための仕組み。
アプリ本体に鍵を埋め込めば誰でも取り出せるので、代わりに Apple の App Attest で
「正規のアプリが本物の Apple 端末で動いている」ことを証明させ、その端末専用のトークンを発行する。

## 流れ

1. アプリが `POST /v1/app/challenge` を呼び、使い捨てのチャレンジ（5 分有効）を受け取る。
2. アプリが `DCAppAttestService.generateKey()` で鍵を作り、
   `attestKey(keyId, clientDataHash: SHA256(challenge の UTF-8))` で証明を得る。
3. アプリが `POST /v1/app/devices` に `{ key_id, attestation, challenge }`（`key_id` と
   `attestation` は base64）を送る。
4. Rialto が証明を検証し、通ればトークンを発行して `201` で返す:
   `{ api_key, plan: "free", model, daily_request_limit }`。

どちらの口もアクセストークンなしで呼べる（`/v1` のトークン検査より前に登録している）。
検証は Apple の手順（Validating apps that connect to your server）の 1〜9 をそのまま行う:
証明書チェーンが同梱の Apple App Attestation Root CA に至ること、nonce がチャレンジと
authenticator data に一致すること、鍵 ID が証明された公開鍵のハッシュであること、
RP ID が `RIALTO_APP_ATTEST_APP_ID` であること、カウンタが 0 であること、環境（本番／開発）。

## 無料プランのトークン

- `modelPin`: どのモデルを指定されても `RIALTO_APP_FREE_MODEL` に置き換えて送る。
  ルーティングも通さない（ルートの連鎖がより高いモデルを選ぶのを防ぐため）。
  リクエストログの `requestedModel` にはアプリが指定したモデルが残る。
- `dailyRequestLimit`: UTC の 1 日あたりの完了リクエスト数。超えると `429`
  （`Retry-After` は次の UTC 0 時まで、`code: daily_limit_exceeded`）。
  `/v1/models` の一覧取得は数えない。
- 使える口は `/v1/responses` と `/v1/chat/completions`。
- 1 つの App Attest 鍵から発行できるトークンは 1 本だけ（`AppDevice.keyId` が一意）。

プランの値は発行時にトークンへ写すので、あとで環境変数を変えても、発行済みのトークンは
変わらない。個別に止めるときは Access tokens 画面から失効させる。

## 設定

| 環境変数 | 内容 |
| --- | --- |
| `RIALTO_APP_ATTEST_APP_ID` | `<Team ID>.<Bundle ID>`（例: `5Q94QJ7G98.jp.qleap.connect`）。必須 |
| `RIALTO_APP_FREE_MODEL` | 無料トークンを固定するモデル（`/v1/models` の id）。必須 |
| `RIALTO_APP_FREE_DAILY_REQUESTS` | 1 日の上限。省略時 100 |
| `RIALTO_APP_ATTEST_ALLOW_DEVELOPMENT` | `true` で Xcode の開発ビルドの鍵も受け付ける。本番では未設定にする |

必須の 2 つが揃うまで、両方の口は `503` を返す。

## まだ無いもの

- 有料プランへの切り替え（App Store のレシート検証）と、アカウントへのひも付け。
- 保存済みの公開鍵を使った App Attest assertion による再発行・鍵の交換。
- `/v1/audio/*`（読み上げ）の中継。今は Irodori-TTS に直接振り分けていて、このトークンは確かめていない。
