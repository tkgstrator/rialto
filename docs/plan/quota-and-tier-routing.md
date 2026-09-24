# クォータ運用の修正と Tier Routing への移行

Status: Planning（2026-09-23 承認）

親ドキュメント:

- [quota-aware-preference-router.md](./quota-aware-preference-router.md) — 置き換え対象の preference chain の設計
- [quota-aware-router-post-phase-4.md](./quota-aware-router-post-phase-4.md) — scheduler / 重みの運用化
- [rialto/master-plan.md](./rialto/master-plan.md) — v3 の再編（Routing 画面・受け口の整理）

本書は 2026-09-23 のレビュー（Claude と Codex CLI に同じ論点を独立にレビューさせ、結果を突き合わせたもの）の結論を実装計画にしたものである。扱うのは次の 3 段階。

- **P0**：小さく効く修正
- **P1**：アカウント単位の可視化と Codex のリセット
- **P2**：Routing を「要求 tier → (provider, tier 別名)」の表に作り直す

---

## 0. 現状（コードを読んで確認した事実）

### 動かない、または誤っているもの

1. **バンク済みリセットに追従できない**
   - 両ベンダーとも、貯めたリセットを任意のタイミングで使えるようになった。
     - Codex：Settings → Reset usage。バンクしたリセットは 30 日で失効する。
     - Claude：`/limit-reset` と Settings → Usage。
   - Rialto は 429 を受けると、`markAccountExhausted(acct, 元のresetAt)` でアカウントをプロセス内で除外する（`src/api/v1/chain-failover.ts:263`）。
   - この除外を**解除する経路が src にない**。`clear{Account,Model,Provider}Exhaustion` を呼んでいるのはテストだけ。
   - Refresh（`POST /api/subscriptions/refresh`）は `SubAccountUsage` / `SubAccountQuota` を書き直す。しかし routing が読む snapshot（`routing-scheduler/state.ts`）は、次の 5 分 tick（`routing-scheduler/index.ts:46`）まで古いまま。
   - その結果、リセットしたアカウントは、他のアカウントが使える間は元の reset 時刻（週次なら数日先）まで後回しにされる。
2. **アカウント別の消費が見えない**
   - `RequestLog` に `subAccountId` がない（`src/prisma/schema.prisma:519`）。
   - cache write は常に `inputPer1M × 1.25`（5 分 TTL）で計算している（`src/services/cost-service.ts:72`）。
   - Anthropic は `cache_creation.ephemeral_{5m,1h}_input_tokens` を返しており、wire 側では宣言済み（`src/schemas/wire/anthropic/sse.ts:33`）。しかし domain の `UsageBlockSchema` で捨てている。1 時間分は 2 倍の料金。
3. **新モデルが出るたびに Routing を張り替える必要がある**
   - `RouterPreferenceEntry.modelId` が Model への直接の FK になっている。
   - さらに、サブスクのプロバイダでは、preset の `defaultEnabledModels`（`src/shared/data/subscriptions.ts:54`）に載っていない新モデルは無効で登録される（`src/services/model-sync-service.ts:152`）。
4. **偽の 429**
   - 例：チェーンが Sonnet だけ、tier の置換が「down only」、要求が Haiku。
     1. Sonnet は格上げ扱いで `tier_mismatch` になり除外される（`src/llms/quota-router/selection.ts:131`）。
     2. 候補がゼロになり、既定の `exhaustedBehavior='429'` によって `retryAfterSec` がセットされる（`src/llms/quota-router/runtime.ts:229`）。
     3. `req.quotaExhaustedRetryAfterSec`（`src/llms/scenario-router.ts:151`）を経て、`rate_limit_error` + Retry-After が返る（`src/api/v1/route-plan.ts:190-205`）。**上流には送っていない。**
   - エントリがすべて無効なときと、全候補の context が足りないときも、同じ経路で偽の 429 になる。
   - ペースによる tier の拡大（`runtime.ts:91-114`）は、画面の up/down 設定より優先される（`selection.ts:123-125`）。
     - このとき tier が分からない候補（manualTier のない Codex など）が落ちる。
     - 既定（上下とも可）ではむしろ候補を**狭めて**いる。
     - 閾値は画面に出ていない。
5. **Routing が過剰**
   - 5 シナリオ × 2 レーン × 順序付きエントリ × tier gate × ペース × scheduler の重み。routing-scheduler / quota-router / scenario-router / preference service / Routing UI を合わせて約 5.8k 行。
   - リクエスト経路が重みを読むのは `weight <= 0` の真偽だけ（`runtime.ts:47`）。
   - damper が既定で効くので、重みは予算に最大 5 tick 遅れる。実際に効いている gate は `100 - remainingBudgetPct >= quotaSkipPct`。
   - `minHealthSamples` はどこからも読まれていない。そのため 1 回の失敗で error rate が 1.0 になり、5 分間除外される。
   - snapshot の対象は `live` profile だけ（`index.ts:125,256`）。他の profile のトラフィックは quota で gate されていない。

### 動いているもの（維持する）

- 429 時のアカウント切り替え（`tryRotateAccount`）は passthrough でも動く。
- アカウント選択（`session-account-router.ts`）、使用量のポーリング、`account-limit.ts` の hold、context window の gate。

### ベンダー側のリセット API（手元のバイナリの文字列から特定）

| ベンダー | 取得 | 消費 | 備考 |
|---|---|---|---|
| Codex（`@openai/codex` 0.152.1） | `GET /backend-api/wham/rate-limit-reset-credits`。`wham/usage` の `rate_limit_reset_credits.available_count` にも入っている | `POST /backend-api/wham/rate-limit-reset-credits/consume`。フィールド候補は `credit_id` / `redeem_request_id`、結果は `reset` / `no_credit` / `windows_reset` | Rialto は `wham/usage` をすでにポーリングしている |
| Claude（Claude Code 2.1.281） | `/api/oauth/usage?cedar_ember=1&skip_spend=1` | `POST /api/organizations/{org}/reset_rate_limits`。`program`（コードネーム `cedar-ember` = バンク済みリセット、`juniper-tide` = セッション上限のリセット）、`grant_id`、`request_id` | コードネームと feature flag で守られた非公開 API。**本計画の対象外** |

---

## 1. 決定事項（2026-09-23）

- スコープは P0〜P2 のすべて、実装まで。
- tier が合わず候補がゼロになったときは、**最も近い tier へフォールバック**する（下位を優先）。厳密モードは残し、その失敗は 429 ではなく 4xx にする。
- リセットの消費ボタンは **Codex のみ**。自動では消費しない。
- tier の別名は**自動では昇格しない**。Refresh は候補を示すだけ。
- 旧チェーンは backfill で移し、expand/contract の 2 リリースで旧テーブルを消す。

---

## Phase P0-1: 偽の 429 をなくす（暫定。P2-4 で置き換える）

### 目的

- 設定の不一致を quota の枯渇として報告しない。
- Haiku の要求が Sonnet だけのチェーンで失敗しないようにする。

### 実装

- `src/schemas/domain/preference.ts` に `tierFallback: z.enum(['nearest','refuse']).default('nearest')` を追加する。
  - JSONB なので DDL は不要。**UI は付けない**（P2 で tier gate ごと消えるため）。
  - 厳密にしたい場合は `PUT /api/router-preferences` で設定する。
- `selectByPreference`（`src/llms/quota-router/selection.ts`）：
  - 1 回目で通る候補がゼロで、かつ `tier_mismatch` の候補があり、`nearest` の場合は 2 回目を行う。
  - 2 回目は `tier_mismatch` の候補を「tier の距離 → 下位を優先 → チェーンの順」に並べ、context / exhausted / error_rate の gate は維持する。
  - 戻り値に `substituted: boolean` を追加し、ログに出す。
- `resolveQuotaAwareSelection`（`runtime.ts`）：

  | skipped の内訳 | 結果 |
  |---|---|
  | `exhausted` か `error_rate` を含む | `exhaustedBehavior` に従う（429 + Retry-After、または passthrough） |
  | `disabled` だけ | passthrough（空のレーンと同じ） |
  | それ以外（refuse による tier_mismatch、全候補の `context_too_small`） | `refusal: string` を返す → 400 |

- ペースによる拡大（`resolveAllowedTiers`）は**呼ぶのをやめる**。コードの削除は P2 で行う。
- `routeScenario` は例外をすべて握りつぶす（`scenario-router.ts:80-92`）ので、4xx は throw では返せない。
  - `RouterRequest.routingRefusal?: string`（`scenario-router/types.ts`）を追加する。
  - `buildRoutePlan` が `passthroughDenial` と同じやり方（`route-plan.ts:218-221`）で `c.json(buildErrorEnvelope({ shape, status: 400, from }), 400)` を返す。

### tests

- `__tests__/llms/quota-router/selection.test.ts`：nearest で Haiku→Sonnet、下位優先、refuse ではゼロ、context gate の維持
- `__tests__/llms/quota-router/runtime.test.ts`：tier だけで落ちたら `retryAfterSec=null` と `refusal`、disabled だけなら passthrough
- `__tests__/api/route-plan.test.ts`：refusal → 400 `invalid_request_error`（Google 形式では `INVALID_ARGUMENT`）
- 既存の 429 テスト（`route-scenario-chain.test.ts:178-187`、`route-plan.test.ts:151-166`）は error_rate で落とすケースなので、そのまま通るはず

---

## Phase P0-2: Refresh を「routing の状態の再同期」にする

### 目的

- ベンダー側でリセットした後や、Refresh を押した直後に、routing が最新の quota で判断する。
- 確認なしで除外を解除するボタンは**作らない**（429 の再送ループになるため）。

### 実装

- `src/services/routing-scheduler/index.ts`：
  - tick 本体（`runSchedulerTickForTest` :246-330）を `runSchedulerTick()` に改名する（テスト用の別名は残す）。
  - 実行中の Promise を共有するガードを付け、`export function republishRoutingSnapshot()` を追加する。タイマーも同じ関数を通す。今は二重実行のガードがない。
- `src/services/failover-state.ts`：
  - `createExhaustionMap` に `clearWhere(pred)` を追加する。
  - `clearModelExhaustionForProvider(providerName)` を追加する（キーは `${provider}||${model}`）。
- `HARD_LIMIT_PCT`（=99）と `accountHasHardLimitHit`（`src/services/session-account-router.ts:149-169`）を export する。もしくは `subaccount-usage-store.ts` に移す。
- `landFreshUsage`（`src/services/subscription-refresh-service.ts:74-85`）の最後に、次を追加する。対象は、最新の値を取れたアカウントだけ。
  1. `getPerAccountUsage(ids)` で最新の値を読む。
  2. **アカウントのマーク**：アカウント全体のウィンドウ（`windowBinds(metric, kind, undefined)`）がすべて `< HARD_LIMIT_PCT`、または reset 済みなら、`clearAccountExhaustion(id)` を呼ぶ。
  3. **モデルのマーク**：そのプロバイダに残っている `(provider, model)` のマークごとに判定する。
     - 「そのモデルに効くウィンドウ（`windowBinds(metric, kind, model)`。Fable などモデル別の週次ウィンドウも含む）がすべて上限未満のアカウント」が 1 つでもあれば、そのモデルのマークだけを消す。
     - プロバイダ単位で一括には消さない。Fable の週次ウィンドウが残っているのに消すと、429 をもう一度踏むため。
     - そのため `failover-state` には `clearWhere(pred)` に加えて、プロバイダ配下のモデルのマークを列挙する `modelMarksFor(providerName)` を追加する。
  4. **プロバイダのマーク**（`insufficient_quota`、`chain-failover.ts:151`）はここでは消さない。これは api_key の課金上限で、サブスクの使用量からは判断できない。既定の 5 分で切れるのに任せる。
  5. `await republishRoutingSnapshot()` を呼ぶ。
  - Refresh、接続時・リセット後の `refreshAccountUsage` は、すべてこの経路を通る。
- 成功時にマークを消す処理は **P1-1 に移す**。`getActiveAccountForSession()` は session 単位の「最後に解決したアカウント」で、同じ session の並行リクエストに上書きされる。これを使うと、別のアカウントのマークを誤って消してしまう。

### tests

- subscription-refresh-service：最新値が上限未満ならマーク解除と snapshot の再作成、上限のままなら維持
- `__tests__/services/failover-state.test.ts`：`clearWhere` とプロバイダ単位の解除
- routing-scheduler：同時に呼んだとき tick が 1 回しか走らないこと

### docs

- `docs/architecture/request-flow.md` の状態ストア表（:177-184）とシナリオ 4 に追記する。
- 状態はプロセスローカルで、複数インスタンスでは共有されないことを明記する。

---

## Phase P1-1: どのアカウントが処理したかを記録する（＋cache write の 1 時間 TTL 分）

### 経路（確認済み）

- アカウントは `resolveSubscriptionAuth`（`src/llms/transformers/oauth-base.ts:84-145`）で選ばれる。3 つの分岐すべてが `credentialsFor(auth)`（:68-82）を通るので、ここで `auth.subAccountId` が必ず分かる。
- `context.req`（PipelineRequest）は、transformer から `captureUsage` まで同じオブジェクトが渡る。
  - 経路：`invocation.ts:166-179` → `route.ts:308` → `pipeline.ts:52-53` → `request-chain.ts:163/173` または `provider-send.ts:121` → `provider-send.ts:91` → `usage-extraction.ts:48-73`
  - `accessTokenId` / `surface` と同じやり方で運べる。
- pipeline 1 回の実行につき、アカウントの解決は 1 回。
  - アカウントを切り替えると `resolveInvocationForModel` が新しい `inv.request` を作るので、記録は試行ごとに分かれる。
  - RequestLog の行は成功した試行でしか書かれない。

### 実装

- `PipelineRequestSchema`（`src/schemas/domain/pipeline.ts:85-129`）に `subAccountId: z.string().nullable().optional()` を追加する。
- `resolveSubscriptionAuth` に引数 `context` を追加し、`credentialsFor` の中で `context.req.subAccountId` をセットする。呼び出し元は `claude-code-oauth.ts:197` と `codex-oauth.ts:87`。
- `src/schemas/domain/usage-record.ts`：
  - `UsageRecordSchema` に `subAccountId: z.string().nullable()` と `cacheWrite1hTokens` を追加する。
  - `UsageBlockSchema` に `cache_creation: z.object({ ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }).partial().optional()` を追加する。
- `src/llms/pipeline/usage-extraction.ts`：
  - `subAccountId` と 1 時間分を詰める。
  - SSE の `message_start`（置き換え）と `message_delta`（マージ）の両方で引き継ぐ（:198-202）。
  - Biome の規則で `??` は使えないので、三項演算子で書く。
- Prisma マイグレーション `add_request_log_sub_account`（precedent は `20260831060051_add_access_token`）：
  - `RequestLog.subAccountId String?`：FK なし。理由は `accessTokenId` と同じで、schema のコメントに書く。
  - `RequestLog.cacheWrite1hTokens Int @default(0)`
  - index は付けない。`createdAt` の範囲で絞る。
  - `bun run db:migrate:test` も実行する。
- `computeCosts`：cache write を `((write − write1h) × 1.25 + write1h × 2) × inputPer1M` にする。
  - `cacheWrite1hTokens` は省略可能にする（既存の呼び出し元を壊さないため）。
  - **`computeCosts` に渡しているすべての箇所**で、select / SUM に `cacheWrite1hTokens` を追加する。漏れた箇所は 1.25 倍のまま残る。
    - 集計：`access-token-service.ts:226`、`overview-service.ts:491` の raw SQL、`api/usage/cost/route.ts`、`api/usage/cost/history/route.ts`
    - Activity：`api/request-logs/logs-crud.ts:47-52`、`sessions.ts:123,146,164,223,239`（select で列を指定している）、`session-detail.ts:72-77`
  - あわせて、それぞれの DTO とブラウザ側の型を更新する。
  - 同じトークン列から、すべての画面で同じ額が出ることを確かめる整合テストを追加する。
- `chain-failover.ts` の `tryRotateAccount`（:251）と long-context gate（:127）：
  - `getActiveAccountForSession` は session 単位で、他のリクエストに上書きされうる。代わりに `inv.request.subAccountId` を優先して使う。
  - auth hook は送信前に走るので、429 のときにもセットされている。
- **成功時のマーク解除**（P0-2 から移したもの）：`attemptChainEntry` の成功処理（`chain-failover.ts:96-107`）で、`inv.request.subAccountId` のアカウントに `clearAccountExhaustion` を呼ぶ。
  - 成功したのならマークは誤りなので消してよい。
  - 試行ごとの ID なので、並行リクエストでも取り違えない。
- `scripts/seed-demo/traffic.ts:303-358` にもデモ用アカウントの id を入れる。

### tests

- `__tests__/parity/usage-record.test.ts`（:132 のテストを雛形にする）
- `__tests__/parity/cache-tokens.test.ts`（1 時間分の内訳）
- `__tests__/llms/transformers/oauth-base.test.ts`（context に書き込まれること）
- `__tests__/api/chain-failover-cooldown.test.ts`
- 新規 `__tests__/services/cost-service.test.ts`

---

## Phase P1-2: アカウント別のトークン数と API 換算額

### 実装

- 新規 `src/services/account-usage-service.ts`。`spendByToken`（`access-token-service.ts:226-258`）と同じやり方で書く。
  - `groupBy(['subAccountId','provider','model'])` → `buildPriceMap` → メモリ上で合計する。
- 期間は 2 つ出す。
  1. **いまの週次ウィンドウ**：開始は `weeklyResetAt − weeklyWindowSeconds`。分からなければ 7 日前。
  2. **直近 30 日**。
  - アカウントごとに開始時刻が違うので、アカウント数だけ groupBy を回す（10 件以下を想定）。
- 価格：サブスクのモデルは `buildPriceMap` の「同じ名前のモデル価格」へのフォールバックで API 換算額になる。価格が分からない場合は 0 ではなく **null** にする。
- 割安度：30 日の API 換算額 ÷ `SubAccount.monthlyPriceUsd`。`monthlyPriceUsd` は今どこにも表示されていない。
- API：`QuotaSchema`（`src/api/overview/route.ts:43-51`）に `usage: { window, last30d, valueRatio }` を追加する。
  - 詰めるのは `buildQuota`（`overview-service.ts:376-408`）。
  - ブラウザ側の型 `OverviewQuotaRow`（`src/lib/api-types.ts`）も合わせる。
  - Overview と AccountsPanel はどちらも `/api/overview` の quota を読んでいる。
- UI（**先にモック**）：`mocks/provider-subscription.html` のアカウント行と `mocks/overview.html` の quota ブロックに追加する。
  - 承認後に `AccountsPanel.tsx:69-107` と `Overview.tsx` の `QuotaAccount` を実装する。
  - 文言には必ず「API換算」を付ける。

### tests

- `__tests__/db/account-usage-service.test.ts`（ウィンドウの開始、価格なし → null、割安度）
- `__tests__/db/overview-service.test.ts`

---

## Phase P1-3: Codex のバンク済みリセット

### Spike（実装の前に行う）

- `GET /wham/rate-limit-reset-credits` の形を確認する。ヘッダは `wham/usage` と同じで、Bearer と `chatgpt-account-id`。
- `POST .../consume` は、**オペレーターの同意を得て 1 度だけ**実行し、リクエストとレスポンスの形を確認する（クレジットを 1 回消費するため）。
- 秘匿情報を消したレスポンスを `__tests__/fixtures/codex/` に保存する。

### 実装

- `CodexUsageWireSchema`（`src/schemas/wire/usage.ts:25-28`）に `rate_limit_reset_credits: z.unknown().optional()` を追加する。
  - 今は plain object なので、この key は黙って捨てられている。
  - `fetch.ts:189-202` で `available_count` を読む。
  - `CodexUsageSchema` に `resetCreditsAvailable: z.number().int().nullable().default(null)` を追加する。キャッシュ済みの値との互換のため `.default` を付ける。
- `SubAccountQuota.resetCreditsAvailable Int?`（マイグレーション）：`refreshQuotaSnapshots` が書き込み、`/api/overview` の quota 行から UI に出す。
- API（precedent は `access-tokens/route.ts:157-193`）：
  - `GET /api/subscriptions/accounts/{id}/reset-credits`：残り回数と失効日。
  - `POST /api/subscriptions/accounts/{id}/reset-usage`：`src/services/codex-reset-service.ts` を呼ぶ。サービスは次を行う。
    1. アカウントを特定する（存在しなければ 404、codex でなければ 409）。
    2. `ensureFreshCodexAccessToken` でトークンを確保する。
    3. `redeem_request_id = crypto.randomUUID()` で consume を呼ぶ。
    4. `refreshAccountUsage([id])` を呼ぶ。これで P0-2 のマーク解除と snapshot の再作成も走る。
  - アカウントを 1 件だけ引くために `getSubAccountTokenById` を `subscription-account-sync/read.ts` に追加する。
- UI（**先にモック**）：`mocks/provider-subscription.html` に Codex 版のバリアントを追加する。
  - 各アカウント行に「リセット n 回（失効 mm/dd）」と「リセットを使う」ボタンを置く。
  - 確認は `useConfirm()`（`ConfirmDialog.tsx:120`）で行う。
  - 文言は `src/locales/{en,ja,zh}.json` の `providers.accounts.*` に追加する（`locale-parity.test.ts`）。
- **自動では消費しない**。失効日を出して、オペレーターが判断する。

### tests

- fetch のパース（fixture）
- codex-reset-service：成功、no_credit、401、codex 以外のアカウント
- route：404 / 409
- AccountsPanel の derive

---

## Phase P2: Tier Routing（要求 tier → provider の tier 別名）

### 目標の設計

**データ**

- `ProviderTierAlias(providerId, tier) → modelId`：「このプロバイダの <tier> はどのモデルか」。新モデルが出たときに動かすのは、この 1 行だけ。
  - **自動では切り替えない**。catalog の Refresh は候補を示すだけで、候補は読み出し時に計算する。
  - 候補の判定：tier が同じで、`Model.createdAt > alias.updatedAt`（別名を最後にセットした後に現れたもの）。seed 済みのモデルは createdAt が同じなので、世代順には使えない。
  - 「昇格」操作で別名をセットし、そのモデルを有効にする。
  - Claude 系のサブスク preset は、プロバイダの Model を最初に作るときに別名も作る（`defaultEnabledModels` から `tierOf` で引く）。Codex / Gemini は tier 名を持たないので作らず、オペレーターが設定する。
  - Model を作る経路は 2 つある。
    - プロバイダの追加：UI が `POST` し、`config/apply/model-rows.ts:59` の `createMany` で作る。
    - catalog の Refresh：`model-sync-service`
  - 両方から同じ `ensurePresetAliases(tx, provider)` を**同じトランザクションの中で**呼ぶ。model-sync だけに入れると、追加直後の Refresh するまで別名がない状態になる。
- `TierRoute(profileId, requestedTier, priority) → (providerId, targetTier, enabled)`：`requestedTier ∈ fable | opus | sonnet | haiku | other`。
  - 要求 tier は `tierOf(body.model)`（`src/llms/scenario-router/request-signals.ts:105`）で決め、判定できなければ `other`。
  - 有効なルートが 1 本もない tier は passthrough にする（今の空レーンと同じ）。
  - 例：`haiku → [claude-code·sonnet]` と書けば、Haiku の要求は Sonnet に回る。**tier の置換は gate ではなく、表に明示的に書く。**
- tier は Prisma の enum ではなく **String + Zod** で持つ（`InboundSurfaceConfig.routingMode` と同じやり方）。新しいモデル系列が出てもマイグレーションが要らない。

**選択器**（`src/llms/tier-router/select.ts`、純粋関数）

- ルートを別名で `provider,model` に解決し、次の gate を通す。
  - **exhaustion**：failover-state のマークと quota snapshot
  - **context window**：`ConfigProvider.modelContextWindows`
  - **error rate**：`minHealthSamples` を実際に効かせる
  - **Web 検索対応**：実際にチェーンを組むときと同じ規則で出した apiStyle が、anthropic / openai_responses / gemini のどれか。
    - Responses は hosted `web_search`（`transformers/openai/responses/request.ts:212-246`）、Gemini は `googleSearch`（`utils/gemini/request-config.ts:76-91`）に置き換わる。除外するのは openai_chat だけ。
    - 純粋関数 `hostsWebSearch(provider, model)` を `src/shared/transformer-chain.ts` に置く。
    - 独自に二択で判定せず、`effectiveApiStyle`（:83。古いサブスクのプロバイダはベース URL から推定する）と、モデル単位の上書き規則（api_key のプロバイダだけ。`modelTransformerChains` :127）を**再利用する**。
    - これで、画面に出す判定と実際に走るチェーンがずれない。
- 全滅したときの扱い：

  | 状況 | 結果 |
  |---|---|
  | 有効なものが何もない（ルートかターゲットが off） | passthrough（`route-scenario-chain.test.ts:229` の契約） |
  | 1 件でも exhaustion か error rate で落ちている | `exhaustedBehavior` に従う（429 + Retry-After、または passthrough） |
  | 別名が未設定、機能がない、context が足りない | 400（`req.routingRefusal`） |

- Retry-After：`failover-state.exhaustedUntil(provider, model)` を新設し、マークの期限と snapshot の `resetAt` のうち早いほうを使う。

**残すもの**

- サーフェスごとの routed / passthrough と `PASSTHROUGH_PROFILE_KEY`
- `RouterPreferenceProfile` の行と `AccessToken.profileKey` / `InboundSurfaceConfig.profileKey`
- constraints。ただし `exhaustedBehavior` / `quotaSkipPct` / `errorRateSkipPct` / `minHealthSamples` の 4 つに絞る
- persona の注入（routed の経路だけ、という現状の挙動のまま）
- サブエージェントタグの**除去**（`<RIALTO-SUBAGENT-MODEL>` と旧 `<CCR-SUBAGENT-MODEL>`）と `RequestLog.isSubagent` の記録
- tokenizer、アカウント選択と切り替え、使用量のポーリング、`account-limit.ts` / `collector.ts` / `modelBudget`（Fable の週次ウィンドウの扱い）

**消すもの**

- シナリオ分類（think / longContext / webSearch / image と longContext の閾値）
- agent / subagent のレーン
- `allowEscalation` / `allowDemotion`、ペースによる拡大
- scheduler の重み（compute / score / shaping / damper）と `RoutingWeightChange`、Overview の weight の行
- `applyProactiveFailover`（選択器に吸収する）
- `router-utilization` と `solver-input`（どちらも UI から呼ばれていない）
- `Model.manualTier`（release B で消す）

**scheduler と RequestLog**

- scheduler は「quota snapshot」に縮める。
  - 対象ごとに `{ exhausted (= remainingBudgetPct === 0、holdSpentAccount の後に判定), remainingBudgetPct, resetAt }` と `soonestResetAt` を持つ。
  - **対象は、有効なサブスクプロバイダの有効なモデルすべて**にする。
- `RequestLog.scenario` は DDL を変えずに、Prisma のフィールドを `route String? @map("scenario")` に改名する。要求 tier か `passthrough` を書き、Activity の「Scenario」列は「Route」にする。

### 旧チェーンからの backfill（release A）

- `src/prisma/seed.ts` から `src/services/routing-migration/backfill-tier-routes.ts` を呼ぶ。
  - `entrypoint.sh` が `migrate deploy` の後に `db seed` を実行するため、ここに置く。
- **失敗したら seed を失敗で終わらせる**。
  - 例外を握りつぶして続行すると、release A が正常に起動したまま、その profile だけルートのない状態（= passthrough）になってしまう。
  - profile ごとのトランザクションなので、成功した profile は印が付いて確定する。失敗した profile は旧チェーンのまま残る。
  - `set -e` でコンテナの起動が止まるので、オペレーターは原因を直すか、旧イメージに戻す。
- `RouterPreferenceProfile.chainBackfilledAt` を印にして、冪等にする。

```
for P in profiles (live first) where chainBackfilledAt is null:
  tx:
    if TierRoute.count(P) > 0: mark; continue
    C = parse(P.constraints)       // allowEscalation / allowDemotion / tierFallback（エントリ単位の上書きは DB に存在しない）
    src[T] = default.agent                        // すべての tier で同じ。理由は下の注を参照
    // Pass 1: 別名の取り合い
    //   優先度: 同じ tier → routable(entry ∧ model ∧ provider 有効) → priority → 非 deprecated → name
    //   既存の別名は上書きしない。live が先に取る
    for (T, e) in sorted claims: aliases[(e.provider, slot(e, T))] ??= e.model
    // Pass 2: ルート
    for T in [fable, opus, sonnet, haiku, other]:
      for e in src[T] by priority:
        t  = manualTier ?? tierOf(name)
        ok = T == 'other' || t == null || t == T || (t が上位 ? C.allowEscalation : C.allowDemotion)
        key = (e.provider, slot(e, T))            // 重複は 1 つにまとめる（有効なほうを残す）
        push TierRoute(P, T, key, enabled = e.enabled && ok)   // gate で弾かれていたものは off で追加し、メモに残す
      // P0-1 の nearest を再現する
      if no enabled route for T and C.tierFallback != 'refuse':
        enable routes of the nearest tier (下位を優先); note("nearest-tier fallback")
    note: subagent レーンと未使用のシナリオレーンは件数だけ記録する
    P.chainBackfilledAt = now()

slot(e, T) = tierOf/manualTier で分かればそれ
           / そのプロバイダでこのモデルがすでに持っている別名
           / T（T != other のとき）
           / [sonnet, opus, haiku, fable] のうち空いている最初のもの
```

- 読むのは**すべての tier で default/agent**。
  - 「opus の要求は longContext に入る」は一般には成り立たない。分類はサイズ → webSearch → think → heavy の順に判定される（`model-selection.ts:103-140`）。
    - effort が low / medium なら heavy にならず default に入る（`request-signals.ts:89-98`）。
    - thinking がある要求は think が優先される。
    - longContext のレーンが空なら default に落ちる。
  - このように要求ごとに行き先が分かれるので、1 つのレーンを選んで再現することはできない。
  - RequestLog から実際に使われていたレーンを推定する案は、複雑すぎるので採らない。
  - think / longContext のレーンにあったエントリは、件数と中身をメモに残す。オペレーターは移行後に必要なら tier 表へ手で足す。
- backfill のテストには、effort が low / medium の opus、thinking のある要求、longContext のレーンが空の場合を含める。
- 別のモデルに解決されるようになったエントリ（例：同じプロバイダの `[opus-4-8, opus-4-7]` が 1 つにまとまる）は、メモに残す。

### 挙動が変わる点（リリースノートの元）

- サブエージェントのトラフィックは、専用のレーンではなく、自分が要求した tier に従う。
- think / longContext / webSearch / image のレーンがなくなる。
  - Web 検索は、対応するターゲットだけに絞る gate に変わる。
  - 大きすぎる要求は、context gate で次のルートに回る。
  - 「heavy な opus の要求や thinking の要求を、別のレーンのモデルに回す」挙動はなくなる。backfill は default/agent だけを読むため。必要なら、移行後に tier 表へ手で足す。
- 同じプロバイダ・同じ tier のフォールバックは 1 つにまとまる。
- 偽の 429 はなくなる。
  - nearest の profile では、`haiku → sonnet` が on で入る。
  - refuse の profile では off で入り、passthrough になる。
- すべてのルートで context が足りない要求は 400 になる（今は偽の 429）。
- ペースによる tier の拡大はなくなる。
- quota の gate が `live` 以外の profile にも効くようになる。

### API（バージョンを分けずに置き換える。SPA とサーバーは同時に出る）

| Endpoint | 内容 |
|---|---|
| `GET /api/routing/profiles` | `{key, routeCount, updatedAt}[]` |
| `GET /api/routing/profiles/{key}` | `{routes: Record<RouteTier, {provider, targetTier, enabled, resolved: {model, targetEnabled, hostsWebSearch, contextWindow} \| null}[]>, constraints}` |
| `PUT /api/routing/profiles/{key}` | 全置換。`passthrough` キーは拒否する。別名が未設定でも拒否せず warning にする |
| `GET /api/tier-aliases` | `[{provider, tier, model \| null, updatedAt, candidates[{model, enabled, isNew}]}]` |
| `PUT /api/providers/{name}/tier-aliases/{tier}` | `{model}`。昇格 = 別名のセット、モデルの有効化、設定ファイルへの同期、context のリセット、`republishRoutingSnapshot` |
| `DELETE /api/providers/{name}/tier-aliases/{tier}` | 別名の解除 |
| `GET /api/routing-scheduler-state` | `{tickAt, targets[{target, exhausted, remainingBudgetPct, resetAt}], accounts, soonestResetAt}` |

- 保存する形は domain 層（`src/schemas/domain/tier-route.ts`）に置く。
- 読み出し用の DTO と `.openapi()` は api 層（`routing.ts` / `tier-alias.ts` / `quota-snapshot.ts`）に置く。

### UI（先にモックを作り、承認を得る）

**別名はプロバイダのページで編集する**。モデルの Tier 列と、新モデルを見つける Refresh がそこにあるため。別名は profile をまたいだプロバイダの属性でもある。

- `mocks/provider-subscription.html` / `provider-apikey.html`：
  - モデル表の上に 4 枠の「Tier aliases」帯を置く。
  - 「N new」バッジから候補を開いて昇格する。
  - モデル表の Tier 列は、読み取り専用の「Alias」列にする。
- `mocks/routing.html`：
  - 帯 1・2 は今のまま。シナリオのタブと Agent/Subagent の切り替えを外す。
  - Fable / Opus / Sonnet / Haiku / Other の 5 グループにする。各行は次のとおり。
    - `#`、provider·tier、解決先のモデル（プロバイダのページへのリンク）
    - 状態：ok / 72% used / exhausted until 14:05 / alias unset→「Providers で設定」/ target off
    - Web 検索不可バッジ、On
  - 空のグループは「ルートなし — 送られたまま passthrough」と表示する。
  - 下部の制約は 4 項目。`?edit` で並べ替え、追加、行メニューを出す。
- `mocks/overview.html` は weight の行を外す。`activity-requests.html` / `activity-session.html` は Scenario を Route にする。
- P1-2 / P1-3 のモック変更と合わせて、**1 回の承認ラウンド**にする。

### ファイルの一覧

**Prisma**

- マイグレーション A（追加だけ）：
  - `ProviderTierAlias`：unique `(providerId, tier)`、`model` は cascade
  - `TierRoute`：unique `(profileId, requestedTier, priority)` と `(profileId, requestedTier, providerId, targetTier)`、`provider` は cascade
  - `RouterPreferenceProfile.chainBackfilledAt`
  - `RequestLog` の `@map` による改名
- マイグレーション B（縮退）：
  - 先頭にガードを置き、次のどちらかを満たす profile があれば `RAISE` する。
    - `RouterPreferenceEntry` があるのに印がない
    - default/agent に有効なエントリがあったのに、`TierRoute` が 0 件
  - drop するもの：`RouterPreferenceEntry`、`RoutingWeightChange`、`ScenarioKey` / `RouterPreferenceKind` の enum、`Model.manualTier`、印の列。
  - constraints から引退したキーを消す（任意）。

**schemas**

- domain：
  - 追加：`tier-route.ts`（Tier、RouteTier、TierRoute、RoutingConstraints、RouteKey）
  - 削除：`preference.ts`、`scenario.ts`、`solver-input.ts`
  - 縮小：`router.ts`、`pipeline.ts:93`、`usage-record.ts:110`、`provider.ts:72`
- api：
  - 追加：`routing.ts`、`tier-alias.ts`、`quota-snapshot.ts`
  - `models.ts:61` から `manualTier` を外す。`request-log.ts:62` のフィールドを改名する。
- shared：
  - `hostsWebSearch` を追加する。
  - `subscriptions.ts` の preset に、任意の `tierAliases` を追加する。
  - `db/types.ts` から `SCENARIO_KEYS` を削除する。

**services**

- 追加：
  - `tier-route-service.ts`（`DEFAULT_PROFILE_KEY` / `PASSTHROUGH_PROFILE_KEY` もここに移す）
  - `tier-alias-service.ts`（候補の計算、セットと有効化、再作成）
  - `routing-migration/backfill-tier-routes.ts`（release A のみ）
- 削除：`router-preference-service.ts`、`router-utilization-service.ts`、`solver/`
- `routing-scheduler/`：`compute.ts` / `score.ts` / `shaping.ts` と `quota-math.ts` の `candidatePace` を削除し、`index.ts` / `state.ts` / `types.ts` を縮める。
- `failover-state.ts`：`exhaustedUntil` を追加する。
- `config/apply/chain-entries.ts` は `tier-route-cascade.ts` にする（呼び出し元は `crud.ts:77`、`apply/providers.ts:27`、`apply/model-rows.ts:49`）。`crud.ts` から `setModelManualTier` を外す。
- `model-sync-service.ts`：プロバイダの Model を最初に作るときに、preset の別名を作る。
- `overview-service.ts`：weight の行（:410-445,556）を外す。

**llms**

- 追加：`tier-router/select.ts`（純粋関数）、`tier-router/runtime.ts`
- `scenario-router.ts` を `routeRequest` に書き直す。タグの除去、persona、`routeKey`、`routingRefusal` を扱う。
- 削除：`quota-router/`、`scenario-router/model-selection.ts`、`applyProactiveFailover`
- `request-signals.ts` に残すのは `tierOf` / `isWebSearchTool` / `stripSubagentTag` だけ。
- `surface-signals.ts` / `utils/gemini/router-signals.ts` の `RouterSignals` は `{tokenize, webSearch}` に縮める。
- `types.ts` と `pipeline/usage-extraction.ts:49-60` も合わせる。

**api**

- 削除：`router-preferences/`、`router-utilization/`、`solver-input/`
- 追加：`routing/profiles/route.ts`、`routing/profiles/[key]/route.ts`、`tier-aliases/route.ts`、`providers/[name]/tier-aliases/[tier]/route.ts`
- `routing-scheduler-state` のレスポンスの形を変える。
- 変更：`v1/route-plan.ts`、`v1/invocation.ts:172`、`v1/chain-failover.ts:154,183,277`
- `src/index.ts` の mount（:26-30,188-191）を合わせる。

**components**

- `routing/`：
  - 残す：`RoutingTabs`、`SurfaceModeBar`、`PassthroughPanel`
  - 書き直す：`RoutingChain`、`ChainTable`、`ChainConstraints`、`AddTargetDialog`、`data`、`derive`、`types`、`useChain*`
  - `useRoutingSelection` はサーフェスだけに縮める。
- `providers/`：
  - `TierAliases.tsx` を追加する。
  - `ModelsTable` / `derive.ts` / `provider-draft.ts` / `actions.ts` から Tier の列と選択を外す。
- Activity は Route 列にする。Overview は weight の行を外す。
- `src/lib/api.ts` / `src/lib/api-types.ts` を合わせる。

**その他**

- locales（en / ja / zh）：`routing.chain.*` のシナリオ / シェア / 置換のキーと overview の weight のキーを削除し、`routing.tiers.*` と `providers.aliases.*` を追加する。
- mocks：`routing.html`、`provider-subscription.html`、`provider-apikey.html`、`overview.html`、`activity-requests.html`、`activity-session.html`、`mocks.json`
- scripts：`seed-demo/{routing,traffic,targets}.ts`
- docs：
  - `CLAUDE.md`（Routing System / Subagent Routing / テーブル）
  - README 3 つ
  - `docs/architecture/{request-flow,inbound-surfaces,inbound-parity,pipeline-overview,testing-map}.md` と新規 `routing.md`
  - `docs/guides/{migration-v3,demo-data}.md`

### tests

- **削除**：
  - `llms/quota-router/{selection,tier-shift,runtime}`、`llms/chain-scenario-gate`、`parity/routing-lanes`
  - `services/routing-scheduler/{compute,pace}`、`services/router-utilization-service`、`services/solver/collect-input`、`api/solver-input`
  - `lib/{routing-constraints,chain-target-state,scheduler-idle,preference-router-schema}`
- **書き直し**：
  - `llms/route-scenario-chain` を `route-request` にする（契約表に 400 の行を追加）。`chain-fixture` を `tier-fixture` にする。
  - `quota-skip` と `context-window-gate` は `tier-router/select` にまとめる。
  - `scenario-router`、`subagent-tag`（除去だけ）、OpenAI / Gemini の signals、`openai-bypass-routing`、`persona-inbound-gate`
  - `parity/{routing-mode,usage-record,failover-429}`、`api/{route-plan,candidate-chain,routing-scheduler-state}`、`api/router-preferences` を `routing-profiles` にする
  - `db/{disabled-targets,passthrough-profile,upsert-provider,config-service,helpers}`、`lib/rialto/provider-draft`
  - `model-health` に minHealthSamples のケースを追加する。
- **追加**：
  - backfill の純粋な planner と、DB での冪等性（印）
  - tier-aliases の API、候補の判定規則、`hostsWebSearch`、Web 検索のパリティ

---

## リリース計画

| # | PR | 内容 | ゲート |
|---|---|---|---|
| 1 | docs | 本書と Codex レビューの反映 | — |
| 2 | P0-1 | 偽の 429 の解消、ペースによる拡大の停止 | — |
| 3 | P0-2 | Refresh での再同期、マーク解除、snapshot の再作成 | — |
| 4 | P1-1 | `RequestLog.subAccountId` と 1 時間 TTL 分 | — |
| 5 | mock | P1-2 / P1-3 / P2 の画面モック | **人間の承認** |
| 6 | P1-2 | アカウント別の API 換算額 | #4, #5 |
| 7 | P1-3 | Codex のリセット（spike → 実装） | #3, #5、spike の consume には**オペレーターの同意** |
| 8 | P2-1 | 拡張マイグレーション、domain schema、サービス、`ensurePresetAliases`（runtime からはまだ使わない） | — |
| 9 | P2-2 | backfill の planner と seed のフック | — |
| 10 | P2-3 | 新しい routing / 別名の API と、純粋な選択器 `tier-router/select.ts`（テスト付き。runtime にはまだつながない） | — |
| 11 | P2-4 | **切り替えの PR**：新しい UI、runtime の切り替え（`routeRequest`、400 / 429、`exhaustedUntil`、minHealthSamples、`RequestLog.route`、snapshot の対象拡大）、旧 routing UI / 旧 API / 分類器 / quota-router / proactive failover / manualTier の UI・PATCH / router-utilization / solver-input の削除 | #5 |
| 12 | P2-5 | scheduler の縮小、その API の形の変更、`RoutingWeightChange` への書き込みの停止 | — |
| 13 | P2-6 | docs と `CLAUDE.md`。`scenario-router/` を `router/` に `git mv` | — |
| — | release A | develop → master | ロールバックの事前確認、backfill のリハーサル |
| 14 | P2-7 | release B：縮退マイグレーション（ガード付き）、backfill の削除 | A が本番で起動し、全 profile に印があること |

- **runtime の切り替えと新しい UI を同じ PR（P2-4）にする**。
  - 切り替えを先に出すと、develop の上で「旧 Routing 画面で保存は成功するのに、実際のトラフィックには効かない」期間ができる。
  - UI を先に出すと、逆に「新しい画面の編集が効かない」期間ができる。
  - PR は大きくなるが、どの時点の develop も矛盾しない。

- ブランチは PR ごとに `develop` から切り、`develop` へ PR を出す。
- すべての PR で CI の 5 ジョブ（Commit Lint / Biome / Type Check / Test / Build）が通ること。マイグレーションを含む PR では `bun run db:migrate:test` も実行する。
- #2〜#4 とモック（#5）は並行して進める。モックの承認を待つ間に P2-1〜P2-3 を進めてよい。
- P0-2 の「成功時のマーク解除」は P1-1 に含める（試行ごとの `subAccountId` が必要なため）。
- **release A のロールバック**：
  - マイグレーションは追加だけなので、1 つ前のイメージで A の DB を読める。旧コードは手つかずの `RouterPreferenceEntry` を読むので、routing は A より前のチェーンに戻る。
  - 事前に DB のコピーで確認すること：
    - 旧イメージの `prisma migrate deploy` が、自分の知らない適用済みマイグレーションを受け付けるか
    - `migrate dev` が自動で seed を走らせるか（走らない場合、dev では `bun run db:seed` が必要）
  - **ロールバック中は Routing を編集しない**（運用上の決まり）。旧イメージでの編集は `RouterPreferenceEntry` にしか入らない。印がある profile はもう backfill されないので、A に戻したときにその編集は失われる。
  - やむを得ず編集した場合は、A に戻す前に `scripts/rebackfill-tier-routes.ts --profile <key>` を実行する。これはその profile の `TierRoute` を消して印を外すスクリプトで、次の `db seed` が旧チェーンから再変換する。
    - 同じ profile で別名を変えていた場合も、上書きはしない（backfill は既存の別名を尊重する）。
    - このスクリプトは release A に含め、release B で削除する。

## 検証

- **P0-1**：
  - dev（:16175、起動済みのもの）の live profile を Sonnet だけにし、`claude-haiku-4-5` を送る → Sonnet で応答すること。
  - `tierFallback: 'refuse'` にすると 400 `invalid_request_error` になること。
- **P0-2**：マークを付けた後、上限を下回る最新値を `landFreshUsage` に渡す → マークが消え、snapshot が新しくなること。
- **P1-1**：1 リクエストで `RequestLog.subAccountId` と `cacheWrite1hTokens` が入ること。
- **UI**：`bun run mocks:shoot && bun run mocks:diff` の `regions`、`bun run test:e2e`。
- **P2**：
  - 移行の前後に、本番 DB で次の SQL を実行して比べる。
  - backfill のリハーサル：本番 DB のダンプを使い捨ての DB に戻し、`migrate deploy` → `db seed` を 2 回実行する。2 回目で何も変わらないこと、メモが期待どおりであることを確認する。
  - 1 つ前のイメージで同じ DB を起動し、ロールバックを確認する。
  - `haiku → claude-code·sonnet` のルートで Haiku の要求が Sonnet に回ること。別名が未設定のルートだけなら 400、全アカウントを使い切った状態なら 429 + Retry-After になること。
  - 別名を昇格した直後のリクエストが、新しいモデルに向くこと。

```sql
-- routing が実際にモデルを書き換えた割合（レーン・シナリオ別）
SELECT scenario, "isSubagent", ("requestedModel" IS DISTINCT FROM model) AS rewritten, count(*)
FROM "RequestLog" WHERE "createdAt" > now() - interval '14 days' GROUP BY 1,2,3 ORDER BY 4 DESC;
```

## Open Questions

- `mythos` などを tier として追加するか。今は `other` 扱いで、String 型なので後から足せる。
- Codex / Gemini の別名の初期値。今はオペレーターが設定する。
- `other` グループは、その profile を共有するすべてのサーフェスの非 Claude モデル名に効く。OpenAI サーフェス用に profile を分けるか。
- Overview の `savedBySubscription`（`overview-service.ts:333-337`、今は null 固定）を P1-2 の API 換算額で埋めるか。
- 旧 API を消した後、開いたままの PWA は 404 になる（安全側）。リロードを案内するか。

## Non-goals

- Claude 側のリセット消費（非公開のコードネーム API のため）
- リセットの自動消費
- 別名の自動昇格
- 複数インスタンス間での状態共有（Redis pub/sub）

## レビュー履歴

- 2026-09-23：Codex CLI（read-only）が本書をコードと照合した。9 件の指摘をすべて確認し、反映した。
  1. backfill の失敗で seed を失敗させる。release B のガードを強める。
  2. runtime の切り替えを新しい UI と同じ PR にする。
  3. モデルのマークはモデルごとのウィンドウで判定して消す。プロバイダのマークは消さない。
  4. 成功時のマーク解除を P1-1 に移す（`getActiveAccountForSession` は並行リクエストで取り違えるため）。
  5. backfill の元はすべての tier で default/agent にする（opus が longContext に入るとは限らない）。
  6. ロールバック中の編集を禁止し、再変換のスクリプトを用意する。
  7. 1 時間 TTL のコストを、Activity の session 系の API にも反映する。
  8. preset の別名を、プロバイダ追加の経路でも作る。
  9. `hostsWebSearch` は `effectiveApiStyle` とモデル単位の上書き規則を再利用する。

## 参考

- [Codex Now Lets You Save Rate Limit Resets and Use Them Later](https://pasqualepillitteri.it/en/news/4783/codex-save-rate-limit-resets)
- [Codex Users Are Losing Banked Rate Limit Resets To A Quiet 30 Day Clock](https://startupfortune.com/codex-users-are-losing-banked-rate-limit-resets-to-a-quiet-30-day-clock/)
- [/limit-reset in Claude Code: What It Actually Resets (2026)](https://explainx.ai/blog/claude-code-limit-reset-command-september-2026)
