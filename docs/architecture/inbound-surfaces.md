# Inbound Surface（受け口）

## 目的

Rialto は「複数のワイヤ形式を受け、呼び出し側が指定したモデルのベンダへ送るゲートウェイ」である。
その **受け口 = inbound surface** の知識を1箇所に集約し、面を増やす作業を「記述子を1つ足す」に落とす。

実装:

- `src/llms/inbound/surfaces.ts` — 記述子レジストリ（唯一の定義元）
- `src/services/inbound-surface-service.ts` — DB上書きを重ねた解決＋キャッシュ
- `src/api/inbound-surfaces/route.ts` — `GET`/`POST /api/inbound-surfaces`
- `src/api/api-key-auth.ts` の `inboundProxyAuth` — 記述子の `auth` で認証ゲートを振り分ける
- `src/api/v1/route.ts` — 記述子から POST ルートをマウントし、`aggregateSse` を選ぶ
- `src/api/v1/route-plan.ts` — 記述子から endpoint transformer と `extractModel` を引く

## なぜ作ったか

面ごとの知識が **4箇所に散っていた**。

| 散っていた場所 | 何を知っていたか | 移管先フィールド |
|---|---|---|
| `src/api/v1/error-shape.ts` の `errorShapeForPath` | エラー封筒の形 | `errorShape` |
| `src/api/v1/route.ts` の `pickSseAggregator` | 非ストリーム集約の関数（transformer名で分岐） | `aggregateSse` |
| `src/index.ts` の `openaiBearerAuth` パス列挙 | 認証ヘッダの種類 | `auth` |
| `src/api/v1/invocation.ts` の `inboundTypeFromPath` | 永続化するワイヤ種別 | `inboundType` |

面を1つ足すたびに4箇所を直す必要があり、どれか1つを忘れても**静かに壊れる**（たとえばエラーだけ
別形式で返る）。記述子に寄せることで、忘れようがなくなる。

**4箇所すべて移管済み**。加えて次の3つも記述子から導出するようにした。

| 導出するもの | フィールド | 使う場所 |
|---|---|---|
| ルートのマウント先 | `endpoint` | `v1Route.post(surface.endpoint, ...)` |
| 認証・アクセスログのマウント先 | `INBOUND_MOUNT_PREFIXES` | `index.ts` |
| body に無いリクエストパラメータ | `extractModel` / `extractStream` | `route-plan.ts` |

### `pickSseAggregator` の移管が挙動を変えないこと

旧実装は `transformer.name` で分岐していた。transformer は自分が登録した `endPoint` 経由でしか
面に到達しないので、**面と transformer は 1:1** であり、2つの分岐が食い違うことは原理的に無い。
`__tests__/llms/inbound-surfaces.test.ts` が、登録済み transformer 全件について
「旧分岐が返す関数 === 記述子の `aggregateSse`」を実際に突き合わせている。

### 認証ミドルウェアの移管で1つだけ挙動が変わった

旧実装は `/v1/chat/completions` などを個別に列挙したうえで `/v1/*` のフォールスルーを置いていた。
Hono はマッチする middleware を**すべて**走らせるので、OpenAI 面に正しい Bearer で入った
リクエストは `openaiProxyAuth` と `proxyAuth` の**両方**を通っていた。つまり `noteTokenUse` が
2回呼ばれ、`AccessToken.requestCount` が実リクエスト数の2倍に膨らんでいた。
記述子ディスパッチ（`inboundProxyAuth`）は面ごとに1つだけ走るので、この二重計上は解消される。
既存の `requestCount` の値はそのまま（遡及補正はしない）。

## 5つの面

| id | path | endpoint | 想定クライアント | inboundType | auth | errorShape |
|---|---|---|---|---|---|---|
| `anthropic-messages` | `/v1/messages` | `/v1/messages` | Claude Code | `anthropic` | `x-api-key` | `anthropic` |
| `openai-chat` | `/v1/chat/completions` | `/v1/chat/completions` | OpenAI SDK | `openai` | `bearer` | `openai` |
| `openai-responses` | `/v1/responses` | `/v1/responses` | Codex CLI | `openai` | `bearer` | `openai` |
| `gemini-generate` | `/v1beta/models/*` | `/v1beta/models/:modelAndAction` | Gemini CLI | `gemini` | `google` | `google` |
| `openai-images` | `/v1/images/generations` | `/v1/images/generations` | OpenAI SDK（画像生成） | `openai` | `bearer` | `openai` |

`path` は `surfaceForPath` がマッチさせる表示用パターン、`endpoint` は Hono のマウント先であり
同時に所有 transformer が宣言する `endPoint` キー（`openai-images` は transformer を持たない）。`/v1` の面では両者は同一で、gemini だけ
食い違う（モデル名が入るパスセグメントを glob では名指しできないため）。

`GET /v1/models` はカタログ読み出しであって完了リクエストの面ではないので、`INBOUND_SURFACES`
には**入れない**。ただし呼び手が OpenAI SDK である以上その認証規約とエラー封筒には従う必要が
あり、それだけを理由に同じファイルの **`CATALOG_PATHS`** に1行だけ置いてある
（`{ path, auth, errorShape }` の3フィールド。`errorShapeForPath` と `inboundProxyAuth` の
どちらも、面レジストリで外したあとにこちらを引く）。`EXTRA_OPENAI_PATHS` という配列は
`error-shape.ts` にはもう無い。

`gemini-generate` は Phase 3 で接続済み。`POST /v1beta/models/:modelAndAction` が実際に
マウントされ、認証・エラー封筒・SSE集約・`RequestLog` 記録まで通る。

### Gemini 面の固有事情

| 事情 | 対処 |
|---|---|
| モデルと action が **URL** にあり body に無い | 記述子の `extractModel` / `extractStream` が `body.model` / `body.stream` に畳み込む。下流（Plan のモデル判定 / failover chain / pipeline / JSON-vs-SSE 判定）はすべて body を読むので、ここが2つのワイヤ規約の合流点 |
| transformer の `endPoint` が `/v1beta/models/:modelAndAction` で、実パスと一致しない | `buildRoutePlan` は `surface.endpoint` で transformer を引く（実パス一致ではない） |
| 認証ヘッダが `x-goog-api-key` / `?key=` | `createProxyAuth({ credential: 'google' })`。受理するのは発行済みアクセストークンだけ（他の /v1 面と同じ） |
| エラー封筒が3種目 `{ error: { code, message, status } }` | `buildErrorEnvelope` の `google` 分岐。`status` は google.rpc.Code 名 |
| bypass 時の outbound URL | provider の `api_base_url` はコレクション（`.../v1beta/models/`）までしか指さないので、`GeminiTransformer.auth` が `<model>:<action>` を付けて URL を組み立てる。同時に `model` / `stream` を body から除去する（Google は未知のトップレベルフィールドを INVALID_ARGUMENT で弾く） |
| gemini 以外の provider に振られたとき | `GeminiTransformer.transformResponseIn` が内部の OpenAI 形を Gemini 形へ戻す。無いと 200 のまま `candidates` を欠いた body が返り、Google SDK は「空の応答」として解釈する（エラーにすらならない） |

`?key=` はクエリ文字列に秘密を載せる唯一の例外である。`ALLOW_API_KEY_QUERY_PARAM` が
そもそもクエリ経由の鍵を拒否しているのは、アクセスログ・履歴・Referer への漏洩を避けるため。
Google のワイヤ規約に代替が無いのでこの面だけ受理する。`accessLog` は `c.req.path`（クエリ無し）
を記録するので、少なくともログファイルには残らない。

### 画像生成面（`openai-images`）

記述子の `operation` は完了系が `'completion'`、この面だけ `'image'`。`'image'` の面には
`aggregateSse` が無く、chat の transformer / pipeline を一切通らない専用ハンドラ
（`src/api/v1/images.ts` の `handleImageGeneration`）がマウントされる。認証（発行済み
アクセストークンの Bearer、面スコープ込み）・OpenAI エラー封筒・アクセスログは他の面と共通。

- **宛先は Codex サブスクリプションだけ。** 受け付けるモデルは `CODEX_IMAGE_MODELS`
  （`src/shared/data/subscriptions.ts`：`gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`）で、
  `authMode = subscription` かつ `apiBaseUrl = https://chatgpt.com/backend-api/codex` の
  provider 上で provider・model とも有効なものに限る。公開のモデル名は素の名前で、同名を
  複数 provider が持つときは Providers → Priorities の順序で選ぶ。未設定の重複・無効・未対応は
  400 で、上流へは何も送らない。旧 `provider,model` 入力も互換のため受け付ける。
- **既定は無効（オプトイン）。** 両モデルは接続前の Codex のカタログに出るが、他のモデルと同じく
  オフで入る。provider ページで有効化する。価格は公開されていないので
  通常の価格3列は null のまま。Codexのサブスク枠に実際の従量課金単価があると誤認させないため、
  API参考単価はモダリティ別に別表示する。chat の候補・モデルテスト・
  scheduler の対象からは外してある。
- **Plan が効く。** `generateImage` が最初に Plan のモデル判定を行い、Plan に無いモデルは 403
  （OpenAI の封筒）。`/codex` の `generate_image` ツールも同じ関数を通る。`deniedTargets` も効く（403）。
- **リクエスト**：`application/json`、128 KiB 以下。`model`・`prompt`（1〜32,000 文字）必須、
  任意で `size`（`auto` / `1024x1024` / `1024x1536` / `1536x1024`）、`quality`
  （`auto` / `low` / `medium` / `high`）、`background`（`auto` / `opaque` / `transparent`）、
  `n: 1`、`response_format: "b64_json"`。それ以外のフィールド（`stream` など）は 400。
  画像編集（`/v1/images/edits`）、ストリーミング、`response_format: "url"`、`n > 1` は非対応。
- **上流**：`<apiBaseUrl>/images/generations` に許可リストのフィールドだけを送る。
  `Authorization` / `chatgpt-account-id` / `originator` はサーバ側で組み立て、呼び手のヘッダは
  転送しない。アカウントは chat と同じ picker（`resolveAccountForSession`）で選び、429 では
  そのアカウントに exhaustion mark を付けて次のアカウントへ回す（最大 10 回）。
- **レスポンス**：上流の JSON（`created` / `data[0].b64_json` / `usage`）をそのまま返す。
  `data` が画像1件でない 2xx は 502。上流のエラーは OpenAI 封筒に包み、`Retry-After` と
  `x-rialto-upstream` を付ける。
- **記録**：成功時に `RequestLog` を1行（`surface = openai-images`、`scenario = passthrough`、
  上流が返したトークン数、`subAccountId`、`accessTokenId`）。`CAPTURE_REQUESTS=false` で止まる。
  プロンプトも画像も `Message` には保存しない。

**モデル情報と単価の更新：** Providers の「Refresh」で OpenAI の公開モデル個別ページ
（`https://developers.openai.com/api/docs/models/gpt-image-2.5-flare` と
`.../gpt-image-2.5-sunburst`）を読み、モデルごとにテキスト入力・キャッシュ入力、画像入力・
キャッシュ入力・画像出力の5レートと公開スナップショットIDを更新する。ページが取れない／
一部欠落した場合は、2026-09-26 時点のコミット済みスナップショットまたは前回の成功値を保持する。
現在の両モデルはテキスト入力 $5 / キャッシュ $1.25、画像入力 $8 / キャッシュ $2、画像出力
$30（いずれも100万トークンあたり）。これは**公開 API の参考価格**であり Codex サブスクの
請求額ではない。価格表と3列の `Model` 単価は入力モダリティを区別できないため、画像モデルの
通常の価格列・Activity の金額は未知のまま。上流の使用量がテキスト／画像別に確認できない状態で
合算トークンを単一の入力単価に掛けることはしない。公開ページの対応エンドポイントに edits が
載っていても、Rialto のこの面は generations のみ受け付ける。新しい画像モデル ID の自動発見は
しない。

Codex の会話モデル一覧は OpenAI の公開価格表から推定しない。接続時と Providers の Refresh 時に、
接続済みアカウントの OAuth bearer と account ID を使って Codex CLI と同じ
`GET https://chatgpt.com/backend-api/codex/models?client_version=...` の `models[].slug`
を取得し、新しい ID を無効のモデル行として追加する。既存行のスイッチは変えず、取得に失敗しても
既存行を消さない。これにより価格表にない `gpt-5.6-terra` なども、アカウントが一覧で返せば
Providers に表示される。公開モデル詳細ページの存在だけではサブスク枠の利用権限は確定しない。
画像モデルは実際に動作確認した2モデルを従来どおり別途扱う。

**注意：この上流は ChatGPT の非公開エンドポイントである。** Codex CLI が使う内部 API で、
OpenAI の公開 Images API の契約ではない。予告なく形が変わり得るので、この面は OpenAI 互換を
保証しない。

## ルーティングは無い — どの面も同じ前処理を通る

どの面も、呼び出し側が指定したモデルをそのまま上流へ送る。かつては面ごとに `routing_mode`
（`routed` / `passthrough`）を保存し、`routed` ならシナリオ別のルートで行き先を決めていたが、
その機構は丸ごと廃止した（[migration-v3.md](../guides/migration-v3.md) §9）。

面が共通に通る前処理は `src/api/v1/route-plan.ts` にあり、順に次のとおり。詳細は
[routing.md](./routing.md)。

1. アクセストークンの **Plan** のモデル判定。Plan に載っていないモデルは、その面自身のエラー形の
   **403** で拒否する（リダイレクトはしない）。モデルを書かないリクエストだけが `defaultModel` になる
2. サブエージェントのタグの除去と `RequestLog.isSubagent` の記録（`/v1/messages` のみ）、
   アクティブなペルソナの挿入（`/v1/messages` のみ）
3. 素のモデル名の provider 解決
4. 面ごとの **deniedTargets**（400）

`InboundSurfaceConfig` に残っている列は `deniedTargets` だけである。行が無い面は何も拒否しない。
読み取りは書き込みで無効化されるキャッシュ越しに行う（`src/services/inbound-surface-service.ts`）。
`/api/inbound-surfaces` で読み書きできるが、いまは編集する画面は無い。

## RequestLog.surface

`inboundType` は `anthropic` / `openai` / `gemini` の3値だが、**`/v1/chat/completions` と
`/v1/responses` を区別できない**（どちらも `openai`）。Overview と Activity は面ごとの内訳を
出すので、`RequestLog.surface` に `InboundSurface.id` のスラグを記録する。

`gemini` の追加に **DDL マイグレーションは不要**だった。`Session.inboundType` /
`RequestLog.inboundType` はどちらも制約なしの nullable TEXT で、Postgres enum ではないため。
広げたのは zod enum（`llm-pipeline.dto` / `llm-usage.dto` / `request-log.dto`）と
`schema.prisma` のコメントのみで、`prisma migrate dev` は "Already in sync" を返す。
ワイヤ形式の集合は面レジストリと一緒に増えるので、enum にすると新しい面が毎回 DDL
マイグレーションとデプロイ順序の危険を伴うことになる — 意図的に TEXT のままにしてある。

移行時のバックフィル（`20260831043000_backfill_request_log_surface`）:

- `inboundType = 'anthropic'` → `/v1/messages` 以外にありえないので `anthropic-messages` を復元
- `inboundType = 'openai'` → 2面のどちらか判別不能。**NULL のまま残す**

推測で埋めない。UI は NULL を「untracked」として表示し、存在しないトラフィックを特定の面に
帰属させない。

### 面ではない `codex-mcp`

Codex MCP サーバー（`/codex`、[guides/codex-mcp.md](../guides/codex-mcp.md)）は **面ではない**。
MCP を話すのでワイヤ形式でもなく、呼び先は常に Codex に固定でルーティングの対象でもない。
だから `INBOUND_SURFACES` には入れず、`InboundSurfaceConfig` の行も持たない。

それでも id `codex-mcp`（`src/shared/codex-mcp.ts`）は面の id と同じ2か所に現れる:

- **トークンのスコープ。** ただし面と違って **オプトイン**で、空のスコープ（全部の面）には含まれない。
  ゲートは `inboundProxyAuth` ではなく `src/api/codex-mcp/auth.ts`。
- **`RequestLog.surface`。** `ask` は `/v1/responses` をプロセス内で呼ぶが、パスが示す
  `openai-responses` ではなく `codex-mcp` で記録する（コンテキスト変数 `surfaceOverride` →
  `RoutePlan.surfaceOverride`）。ヘッダで渡さないのは、クライアントが自分のトラフィックの
  ラベルを付け替えられないようにするため。画像は `generateImage` の `caller.surface` で同じく記録する。

## 面を1つ足す手順

**`INBOUND_SURFACES` に記述子を1つ足す。** ルートのマウント・認証ゲート・アクセスログ・
エラー封筒・SSE集約・`inboundType` / `surface` の記録・トークンの面スコープは、
すべてそこから導出される。

記述子に**書く値が無い**場合だけ、その値を作る作業が別途要る。

| 条件 | 追加で要るもの |
|---|---|
| 新しいワイヤ形式 | endpoint transformer 1つ（`endPoint` は記述子の `endpoint` と一致させる）。`transformRequestOut`（wire → 内部形）と `transformResponseIn`（内部形 → wire）の両方。|
| 新しいエラー封筒 | `buildErrorEnvelope` に分岐1つ、`unauthorizedResponse` に 401 の形1つ |
| 新しい非ストリーム集約 | `sse-aggregate/` にファイル1つ（ワイヤ形式ごとに1ファイル）と barrel の1行 |
| 新しい認証規約 | `presentedSecret` に読み取り1行、`GATE_BY_CREDENTIAL` に1エントリ |
| 新しい `inboundType` の値 | 3つの zod enum を広げる（DDL は不要 — 列は制約なしの TEXT） |

いずれも「新しい概念を1つ持ち込んだときだけ」であって、面を足すこと自体には要らない。
たとえば5つ目が OpenAI 互換の別パスなら、記述子1つで終わる。

DBマイグレーションは不要（`InboundSurfaceConfig` は行が無ければ何も拒否しない）。

## 関連

- [`docs/architecture/inbound-parity.md`](./inbound-parity.md) — **面 × 機能のパリティ表**。
  記述子を足せば面は増えるが、増えた面がどこまで実際に動くかは記述子の外側（変換層）で決まる。
  その実態と、未対応セルの理由・担保テストはあちら。
- [`docs/architecture/routing.md`](./routing.md) — 前処理（Plan のモデル判定・素のモデル名の解決・deniedTargets）と quota snapshot
- [`docs/architecture/request-flow.md`](./request-flow.md) — その後の failover chain と 429 ローテーション
- [`docs/architecture/pipeline-overview.md`](./pipeline-overview.md) — 起動から応答整形までの通し動線
- `docs/plan/rialto/master-plan.md` §4.1, §4.2 — 設計の経緯

## 実装状況（Phase 5 時点）

| 画面 | ルート | モック差分 (light / dark) |
|---|---|---|
| Overview | `/overview` | 1.76% / 1.85% |
| Providers — subscription | `/providers/:name` | 3.89% / 7.75% |
| Providers — api_key | `/providers/:name` | 3.83% / 7.15% |
| Providers — connect | `/providers/connect` | 7.22% / 14.66% ※1 |
| Activity — Sessions | `/activity` | 1.96% / 2.88% |
| Activity — Requests | `/activity/requests` | 3.43% / 5.14% |
| Activity — Logs | `/activity/logs` | 3.22% / 7.12% |
| Settings — Server | `/settings` | 1.54% / 1.63% |
| Settings — Access | `/settings/access` | 12.3% / 12.6% ※2 |
| Settings — Logging | `/settings/logging` | 2.28% / 2.29% |
| Settings — Personas | `/settings/personas` | 4.73% / 5.63% |
| Settings — Advanced | `/settings/advanced` | 4.23% / 4.36% |
| First run | `/setup` | 2.85% / 3.01% |
| System states | `/access-denied` ほか | 3.22% / 9.53% |
| Session detail | `/activity/sessions/:sessionId` | セッション実データが無く撮影できない（ルート自体は登録済み） |

差分の大半は**モックのダミー値と実データの差**である（このインストールには provider が3件、モックのフィクスチャには7件、など）。
当時測った Routing 系の画面と Settings — Presets は、その後ルートごと廃止されたので、表から外してある。

10% を超える2画面は、どちらも**モックと実機が別の状態を描いている**ことによる既知差分で、実装の欠落ではない。
コピーや構造をいじっても下がらないので、追わないこと。

- ※1 `providers-connect`: モックは3ステップの**2番目**（認証中）を描いているが、ルートは当然1ステップ目で開く
- ※2 `settings-access`: モックは **Cloudflare Access 設定済み**のインストール（サインイン済みメール、
  ポリシー行2件）を描いている。未設定のインストールは正しくもう一方の状態を描き、
  モックには存在しない露出警告が加わる
