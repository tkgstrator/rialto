# プランと利用枠

アクセストークンは **プラン** に載せられる（Access tokens → Plans、トークンの詳細ページか発行ダイアログで選ぶ）。
プランが決めるのは 2 つ。

- 使えるモデル（`models`）と、それ以外を名指したリクエストの送り先（`defaultModel`）。
- 利用枠ごとの上限。**5 時間の枠**と **7 日の枠**のそれぞれに、**リクエスト数**と **金額（USD）** の上限を置ける。
  4 つとも独立していて、空欄（`null`）ならその軸は無制限。

プランなしのトークンは無制限。プランは参照でトークンに値をコピーしないので、プランの編集は載っているすべての
トークンに次のリクエストから効く。

## 枠の動き

Claude / Codex のサブスクリプションの枠と同じ形で、スライディングウィンドウではない。

- トークンと枠の長さ（`5h` / `7d`）ごとに 1 行（`AccessTokenUsageWindow`）。`startedAt`・`requests`・`costUsd` を持つ。
- 開いている枠が無いときの最初のリクエストで枠が始まる（`startedAt` = そのリクエストの時刻）。
- `startedAt` + 長さを過ぎると、その枠は終わり。次のリクエストで新しい枠が始まり、回数と金額は 0 から数え直す。
  終わった枠の行は消さずに残り、次の受け付けで上書きされる。使用量としては読まれない。
- 数えるのは上限を 1 つ以上持つプランのトークンだけ。上限の無いトークンには行を作らない。

## 受け付けと拒否

`/v1/*` のゲート（`src/api/api-key-auth.ts`）と Codex MCP の `chargeCall`（`src/api/codex-mcp/tool-context.ts`）が、
補完を受け付ける前に `admitRequest`（`src/services/usage-window-service.ts`）を呼ぶ。

- 開いている枠で `requests >= リクエスト上限` か `costUsd >= 金額上限` なら拒否。面のエラー封筒で 429、
  `Retry-After` はリセットまでの秒数、メッセージは枠・上限の種類・リセット時刻（ISO）を名指す。
  両方の枠が埋まっているときは、遅い方のリセットを返す。
- 受け付けたら両方の枠に 1 回数える（無ければ開き、終わっていれば始め直す）。拒否は数えない。
- 台帳に書けないときは通さず 503（上限が唯一の歯止めなので、台帳の障害を上限の解除にしない）。
- `/v1/models`・`count_tokens`・`/v1/audio/*` は数えない。

同時実行: 受け付けはトークンごとの `pg_advisory_xact_lock` の中で「読む → 判定 → upsert」を 1 トランザクションで行う。
枠がまだ無いとき（ロックする行が無い）や、リセットの瞬間に複数のリクエストが来ても、上限 L に対して通るのはちょうど L 件。

## 金額

金額はリクエストが終わってからしか分からないので、使用量を記録するところで足す。

- 補完: `src/api/v1/route.ts` の `recordUsage`（Codex MCP の `ask` もここを通る）。
- 画像: `src/api/v1/images.ts` の `recordImageUsage`（Codex MCP の `generate_image` もここ）。

どちらも `recordCallSpend` が、トークンの Cost 列と同じ `buildPriceMap` / `computeCosts` で価格を付け、その時点で
開いている枠の `costUsd` に足す。`CAPTURE_REQUESTS=false` でも足す（キャプチャを切ると金額上限も切れる、にはしない）。
価格の無いモデル — サブスクリプションのモデルはすべてそう — は回数だけ増え、金額は増えない。

上限をまたぐリクエストは最後まで返り、その次のリクエストが拒否される。

## リセット

- トークン 1 本: `POST /api/access-tokens/{id}/usage-windows/reset`。トークンの詳細ページの「利用量をリセット」。
- 全トークン: `POST /api/access-tokens/usage-windows/reset`。Access tokens 一覧の「すべての利用量をリセット」。

どちらも枠の行を消すだけで、プランは変わらない。次のリクエストで新しい枠が始まる。
現在の値は `GET /api/access-tokens/{id}/usage-windows` と、Codex MCP の `status` ツールの `yourToken.windows` で読める。
