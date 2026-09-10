# Inbound Surface（受け口）

## 目的

Rialto は「複数のワイヤ形式を受け、複数のベンダへ振り分けるルーティング・ゲートウェイ」である。
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

## 4つの面

| id | path | endpoint | 想定クライアント | inboundType | auth | errorShape |
|---|---|---|---|---|---|---|
| `anthropic-messages` | `/v1/messages` | `/v1/messages` | Claude Code | `anthropic` | `x-api-key` | `anthropic` |
| `openai-chat` | `/v1/chat/completions` | `/v1/chat/completions` | OpenAI SDK | `openai` | `bearer` | `openai` |
| `openai-responses` | `/v1/responses` | `/v1/responses` | Codex CLI | `openai` | `bearer` | `openai` |
| `gemini-generate` | `/v1beta/models/*` | `/v1beta/models/:modelAndAction` | Gemini CLI | `gemini` | `google` | `google` |

`path` は `surfaceForPath` がマッチさせる表示用パターン、`endpoint` は Hono のマウント先であり
同時に所有 transformer が宣言する `endPoint` キー。`/v1` の3面では両者は同一で、gemini だけ
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
| モデルと action が **URL** にあり body に無い | 記述子の `extractModel` / `extractStream` が `body.model` / `body.stream` に畳み込む。下流（scenario router / failover chain / pipeline / JSON-vs-SSE 判定）はすべて body を読むので、ここが2つのワイヤ規約の合流点 |
| transformer の `endPoint` が `/v1beta/models/:modelAndAction` で、実パスと一致しない | `buildRoutePlan` は `surface.endpoint` で transformer を引く（実パス一致ではない） |
| 認証ヘッダが `x-goog-api-key` / `?key=` | `createProxyAuth({ credential: 'google' })`。**bootstrap token は受理しない**（他の /v1 面と同じ） |
| エラー封筒が3種目 `{ error: { code, message, status } }` | `buildErrorEnvelope` の `google` 分岐。`status` は google.rpc.Code 名 |
| bypass 時の outbound URL | provider の `api_base_url` はコレクション（`.../v1beta/models/`）までしか指さないので、`GeminiTransformer.auth` が `<model>:<action>` を付けて URL を組み立てる。同時に `model` / `stream` を body から除去する（Google は未知のトップレベルフィールドを INVALID_ARGUMENT で弾く） |
| gemini 以外の provider に振られたとき | `GeminiTransformer.transformResponseIn` が内部の OpenAI 形を Gemini 形へ戻す。無いと 200 のまま `candidates` を欠いた body が返り、Google SDK は「空の応答」として解釈する（エラーにすらならない） |

`?key=` はクエリ文字列に秘密を載せる唯一の例外である。`ALLOW_API_KEY_QUERY_PARAM` が
そもそもクエリ経由の鍵を拒否しているのは、アクセスログ・履歴・Referer への漏洩を避けるため。
Google のワイヤ規約に代替が無いのでこの面だけ受理する。`accessLog` は `c.req.path`（クエリ無し）
を記録するので、少なくともログファイルには残らない。

## routingMode — 「messages専用に見える」問題の正体

`routed` は シナリオ分類 → 選好チェーン（quota-aware 選択）→ failover の全段を通す。
`passthrough` は呼び出し側が `provider,model` を自分で指定する前提で、**全段をスキップ**する。
ルーティングの機構はこの 2 つだけである（ルール・スロット・プリセットは無い）。

この分岐自体は妥当だった（OpenAI互換クライアントは自分でモデルを選ぶ）。問題は
`scenario-router.ts` に**ハードコードされていて、UIから見えず、切り替えられない**ことだった。

```ts
// 旧: 固定・不可視
if (req.inboundPath === '/v1/chat/completions' || req.inboundPath === '/v1/responses') { ... }

// 新: 設定
if (!(await isRoutedPath(req.inboundPath))) { ... }
```

結果として `RouterPreferences` / `RoutingLibrary` / `TierEditor` などの画面が事実上
「`/v1/messages` 専用の設定画面」になっていた。これが **「UI上の機能が全部messagesだけの設定に
なっている」の正体**である。

### 記述子に `defaultRoutingMode` は無い

面ごとの既定値は**廃止した**。旧実装は messages=routed / 他=passthrough を記述子に持っていたが、
それはハードコードされた bypass を場所を変えて再現しただけで、何も表現していなかった。さらに
UI 側に「見た目が同じ2つの値のうちどちらが出荷時のものか」を説明させる負債を生んでいた
（旧 `overridden` フラグの存在理由がそれ）。

いまは全面が `InboundSurfaceConfig` に**明示的な保存済みモードを1つ**持つ。起動時の
`ensureInboundSurfaces()` が、行の無い面に単一の

```ts
export const INITIAL_ROUTING_MODE: RoutingMode = 'passthrough'
```

を入れる（既存行は触らない。冪等）。読み取り側（`listSurfaces`）も、まだ行が無い面には同じ
seed 値を返すので、「面ごとの既定値」を発明する必要がどこにも無い。

**passthrough が seed なのは、未設定のインストールでルーティングを走らせても何も起きないから。**
選好チェーンが無い状態では、セレクタは呼び出し側の model に素通りする。ルーティングは
振り先が揃ってから面ごとに有効化するものである。

つまり **新規インストールは `/v1/messages` すらルーティングしない**。旧ビルドからの移行では
Routing 画面で明示的に `routed` へ切り替える必要がある — ここは旧挙動を踏襲していない、
意図的な非互換点である。

## profileKey — 面ごとの選好チェーン

`RouterPreferenceProfile.key` は元々「将来の preference presets 用」としてスキーマコメント付きで
置かれ、`key='live'` のシングルトンのまま眠っていた。面ごとルーティングがその用途である。

```
InboundSurfaceConfig.profileKey → RouterPreferenceProfile.key → entries
```

リクエスト時に `scenario-router.ts` が inbound path から面を解決し、その `profileKey` を
quota-aware セレクタへ渡す。これにより **CIのクライアントが叩く面だけ cost-first に固定する**
といった運用ができる。上書きの無い面は既定プロファイルに解決されるので、これも既定では旧挙動。

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

## 面を1つ足す手順

**`INBOUND_SURFACES` に記述子を1つ足す。** ルートのマウント・認証ゲート・アクセスログ・
エラー封筒・SSE集約・`inboundType` / `surface` の記録・トークンの面スコープ・Routing 画面の
行は、すべてそこから導出される。

記述子に**書く値が無い**場合だけ、その値を作る作業が別途要る。

| 条件 | 追加で要るもの |
|---|---|
| 新しいワイヤ形式 | endpoint transformer 1つ（`endPoint` は記述子の `endpoint` と一致させる）。`transformRequestOut`（wire → 内部形）と `transformResponseIn`（内部形 → wire）の両方 |
| 新しいエラー封筒 | `buildErrorEnvelope` に分岐1つ、`unauthorizedResponse` に 401 の形1つ |
| 新しい非ストリーム集約 | `sse-aggregate/` にファイル1つ（ワイヤ形式ごとに1ファイル）と barrel の1行 |
| 新しい認証規約 | `presentedSecret` に読み取り1行、`GATE_BY_CREDENTIAL` に1エントリ |
| 新しい `inboundType` の値 | 3つの zod enum を広げる（DDL は不要 — 列は制約なしの TEXT） |

いずれも「新しい概念を1つ持ち込んだときだけ」であって、面を足すこと自体には要らない。
たとえば5つ目が OpenAI 互換の別パスなら、記述子1つで終わる。

DBマイグレーションは不要（`InboundSurfaceConfig` は行が無ければ記述子の既定値を使う）。
起動時の `ensureInboundSurfaces()` が新しい面にも行を1つ入れる。

## 関連

- [`docs/architecture/inbound-parity.md`](./inbound-parity.md) — **面 × 機能のパリティ表**。
  記述子を足せば面は増えるが、増えた面がどこまで実際に動くかは記述子の外側（変換層）で決まる。
  その実態と、未対応セルの理由・担保テストはあちら。
- [`docs/architecture/request-flow.md`](./request-flow.md) — この後段の chain / failover
- [`docs/architecture/pipeline-overview.md`](./pipeline-overview.md) — 起動から応答整形までの通し動線
- `docs/plan/rialto/master-plan.md` §4.1, §4.2 — 設計の経緯

## 実装状況（Phase 5 時点）

| 画面 | ルート | モック差分 (light / dark) |
|---|---|---|
| Overview | `/overview` | 1.76% / 1.85% |
| Routing — Chain | `/routing` | 3.51% / 3.82% |
| Routing — Chain (passthrough) | `/routing?surface=openai-responses` | 2.45% / 3.55% |
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
| Settings — Status line | `/settings/statusline` | 2.24% / 3.03% |
| Settings — Advanced | `/settings/advanced` | 4.23% / 4.36% |
| First run | `/setup` | 2.85% / 3.01% |
| System states | `/access-denied` ほか | 3.22% / 9.53% |
| Session detail | `/activity/sessions/:sessionId` | セッション実データが無く撮影できない（ルート自体は登録済み） |

差分の大半は**モックのダミー値と実データの差**である（このインストールには provider が3件、モックのフィクスチャには7件、など）。
当時測った Routing — Map / Routing — Rules / Settings — Presets の3画面は、その後ルートごと廃止された
（ルーティングは chain と passthrough だけになった）ので、表から外してある。

10% を超える2画面は、どちらも**モックと実機が別の状態を描いている**ことによる既知差分で、実装の欠落ではない。
コピーや構造をいじっても下がらないので、追わないこと。

- ※1 `providers-connect`: モックは3ステップの**2番目**（認証中）を描いているが、ルートは当然1ステップ目で開く
- ※2 `settings-access`: モックは **Cloudflare Access 設定済み**のインストール（サインイン済みメール、
  ポリシー行2件）を描いている。未設定のインストールは正しくもう一方の状態を描き、
  モックには存在しない露出警告が加わる
