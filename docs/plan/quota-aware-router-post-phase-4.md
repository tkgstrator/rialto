# Quota-Aware Router: Phase 5〜8 (Post-Phase-4 計画)

> **置き換え済み（2026-09）:** 本書のルーティング設計はティアマップ（要求ティア → プロバイダのティアエイリアス）に置き換えられた。現行の設計は [quota-and-tier-routing.md](./quota-and-tier-routing.md) を参照。

Status: Planning

親ドキュメント:

- [quota-aware-preference-router.md](./quota-aware-preference-router.md) — Phase 1〜4 の設計
- [subscription-utilization-tuning-implementation.md](./subscription-utilization-tuning-implementation.md) — Level 2 (utilization dashboard) の骨格
- [subscription-utilization-tuning.md](./subscription-utilization-tuning.md) — L1〜L4 枠組み

Phase 1〜4 (v2.45.0〜v2.52.0) で **quota-aware preference router のバックエンド全体** が landed 済み。本書は「機能は動くが人が触れない/観測できない」現状から、**運用可能な状態** に持っていく Phase 5〜8 を扱う。

---

## 現状 (v2.52.0 時点)

**動くもの**:
- `SubAccountQuota` の 5min ごとの populate (Phase 1)
- `RouterPreferenceProfile` / `RouterPreferenceEntry` の CRUD API (Phase 2b)
- pure preference selector + scheduler + model-health + rollout bucketing (Phase 2c〜2e)
- `routeScenario` の quota-aware / shadow 分岐 (Phase 3)
- 全滅時の 429 + Retry-After + scenario deprecation warning (Phase 4)

**動かないもの / 未実装**:
- **preferences を編集する UI が無い** → API は叩けるが人が触れない
- **scheduler state を観測する API が無い** → 現在の weights / quota snapshot が見えない
- **utilization dashboard が無い** → subscription 稼働率が可視化されない
- **scenario router がまだ残っている** → 100% rollout 後の削除待ち

---

## Phase 5: Observability API

### 目的

現在の routing snapshot (weights + quota state + 最新 changes) を UI と operators に露出する。Dashboard (Phase 7) と Preference editor (Phase 6) がこの API に依存するので、**Phase 5 を最初に着手する**。

### スコープ

新規エンドポイント `GET /api/routing-scheduler-state`。read-only、認証は既存の `apiKeyAuth` を再利用。

### 実装

**新規ファイル: `src/api/routing-scheduler/state/route.ts`**

```ts
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { getRecentWeightChanges, getRoutingSnapshot } from '../../../services/routing-scheduler'

const WeightEntryDtoSchema = z.object({
  target: z.string().nonempty(),
  weight: z.number().min(0).max(1),
  healthiness: z.number().min(0),
  remainingBudgetPct: z.number().nullable(),
  earliestResetAt: z.string().nullable(),
  reasons: z.array(z.string().nonempty())
})

const AccountQuotaViewDtoSchema = z.object({
  subAccountId: z.string().nonempty(),
  providerName: z.string().nonempty(),
  kind: z.enum(['claude', 'codex']),
  fiveHour: z.object({ used: z.number(), limit: z.number(), resetAt: z.string().nullable() }).nullable(),
  weekly:   z.object({ used: z.number(), limit: z.number(), resetAt: z.string().nullable() }).nullable(),
  refreshedAt: z.string().nullable(),
  stale: z.boolean()
})

const SchedulerStateResponseSchema = z
  .object({
    tickAt: z.string().nullable(),
    tickCount: z.number().int(),
    consecutiveFailures: z.number().int(),
    degraded: z.boolean(),
    weights: z.array(WeightEntryDtoSchema),
    accounts: z.array(AccountQuotaViewDtoSchema),
    soonestResetAt: z.string().nullable(),
    recentChanges: z.array(
      z.object({
        target: z.string().nonempty(),
        from: z.number(),
        to: z.number(),
        reason: z.string().nonempty(),
        tickAt: z.string().nonempty()
      })
    )
  })
  .openapi('RoutingSchedulerStateResponse')

export const routingSchedulerStateRoute = new OpenAPIHono()

const getRoute = createRoute({
  method: 'get',
  path: '/api/routing-scheduler-state',
  responses: {
    200: {
      description: 'Current routing snapshot + recent weight changes',
      content: { 'application/json': { schema: SchedulerStateResponseSchema } }
    }
  }
})

routingSchedulerStateRoute.openapi(getRoute, async (c) => {
  const snap = getRoutingSnapshot()
  if (snap === null) {
    // Cold-boot before the first tick. Empty snapshot lets the UI
    // render "no data yet" without a 404.
    return c.json(
      { tickAt: null, tickCount: 0, consecutiveFailures: 0, degraded: false,
        weights: [], accounts: [], soonestResetAt: null, recentChanges: [] },
      200
    )
  }
  return c.json({
    tickAt: new Date(snap.tickAt).toISOString(),
    tickCount: snap.tickCount,
    consecutiveFailures: snap.consecutiveFailures,
    degraded: snap.degraded,
    weights: [...snap.weights.values()].map((w) => ({
      target: w.target,
      weight: w.weight,
      healthiness: w.healthiness,
      remainingBudgetPct: w.remainingBudgetPct,
      earliestResetAt: w.earliestResetAt ? new Date(w.earliestResetAt).toISOString() : null,
      reasons: [...w.reasons]
    })),
    accounts: snap.accounts.map((a) => ({
      ...a,
      fiveHour: a.fiveHour ? { used: a.fiveHour.used, limit: a.fiveHour.limit, resetAt: a.fiveHour.resetAt ? new Date(a.fiveHour.resetAt).toISOString() : null } : null,
      weekly:   a.weekly   ? { used: a.weekly.used,   limit: a.weekly.limit,   resetAt: a.weekly.resetAt   ? new Date(a.weekly.resetAt).toISOString()   : null } : null,
      refreshedAt: a.refreshedAt ? new Date(a.refreshedAt).toISOString() : null
    })),
    soonestResetAt: snap.soonestResetAt ? new Date(snap.soonestResetAt).toISOString() : null,
    recentChanges: getRecentWeightChanges().map((c) => ({
      target: c.target, from: c.from, to: c.to, reason: c.reason,
      tickAt: new Date(c.tickAt).toISOString()
    }))
  }, 200)
})
```

**wire-up (`src/index.ts`)**: `app.route('/', routingSchedulerStateRoute)` を `routerPreferencesRoute` の隣に足す。

**tests**: `__tests__/api/routing-scheduler-state.test.ts` — 空 snapshot / populated snapshot / recentChanges の 3 ケース。

**推定工数**: 半日、~200 LOC。

---

## Phase 6: Router Preference Editor UI

### 目的

`/api/router-preferences` を叩ける UI。現状は `curl` で PUT するしか無い。

### スコープ

Router 編集画面 (`src/routes/router` あるいは同等) に **Preference タブ** を追加。既存の scenario 編集タブと並列。

### UI 構成

```
┌─ Router Preferences ───────────────────────────────────┐
│                                                        │
│ Priority chain (drag to reorder):                      │
│                                                        │
│ ┌────────────────────────────────────────────────┐    │
│ │ 1  claude-code,claude-fable-5   [enabled ●]   │    │
│ │    Subagent tiers: [ ] [sonnet✓] [haiku✓] ... │    │
│ │    weight: ▓▓▓▓▓▓▓▓░░ 82%  budget: 45%       │    │
│ ├────────────────────────────────────────────────┤    │
│ │ 2  claude-code,claude-opus-5    [enabled ●]   │    │
│ │    ...                                          │    │
│ └────────────────────────────────────────────────┘    │
│                                                        │
│ [ + Add model to chain ]                               │
│                                                        │
│ ── Constraints (advanced) ─────────────────            │
│ [ ] sonnet tier respect        [x] haiku tier respect │
│ minWeightPct:              [1     ]                    │
│ exhaustedBehavior: (o) 429 ( ) passthrough             │
│                                                        │
│ [ Save ]                    [ Discard changes ]        │
└────────────────────────────────────────────────────────┘
```

### 実装ポイント

- **エディタ本体**: `src/components/router/PreferenceEditor.tsx` (新規)。既存 shadcn コンポーネント (`Switch`, `Select`, `Input`, `Button`) で組む。**`Card` 禁止** (memory: no Card component)。border-l accent + hover:bg-muted/50 パターン。
- **drag-and-drop**: `@dnd-kit/sortable` を追加? or 素朴に 上下矢印ボタン。まず後者で MVP。
- **weight/budget バッジ**: Phase 5 の `/api/routing-scheduler-state` を tanstack-query で 30s ごとに poll。read-only 表示、編集はしない。
- **保存**: `PUT /api/router-preferences` を Zodios client 経由 (memory: no raw fetch)。楽観 UI なし、レスポンス受けてから toast。
- **warnings 表示**: apply が返す `warnings[]` を toast で表示 (Dropped preference entry ... の類)。
- **モード切替**: ROUTER_MODE / ROUTER_SHADOW / ROUTER_ROLLOUT_PCT の envelope key を編集するのは Phase 6 スコープ外 (別の設定タブ)。

### tests

- `__tests__/routes/router-preferences.test.tsx` あたりに render + interaction (Testing Library)
- 既存 `frontend:tanstack-query-best-practices` skill 参照

**推定工数**: 2〜3 日、~600 LOC。

---

## Phase 7: Utilization Dashboard

### 目的

subscription-utilization-tuning-implementation.md の **Level 2** (§Part A) を実装。「どのスロットに実際どれだけトラフィックが流れてるか」「Fable が余ってないか」の可視化。

### 位置づけ

親 doc の Part A を Phase 5 の API を土台に**再スコープ**する。Phase 5 の `routing-scheduler-state` に加えて、`RequestLog` の集計 API が必要。

### 実装

**新規 API `GET /api/router-utilization`** (親 doc §A に詳細):

```
{
  window: '24h' | '7d',
  perScenario: [{ scenario, total, ok, err429, err5xx, byModel: [...] }],
  perModel: [{ target, requested, sent_to, count }],
  perAccount: [{ subAccountId, providerName, requestCount, currentBudgetPct, resetAt }]
}
```

SQL は親 doc §A の 3 クエリを流用。

**UI**: 新規タブ `/router/utilization` (or `/dashboard/routing`) に:
- **Fable 稼働率グラフ** (時系列、Phase 1 の `SubAccountQuota.quotaRefreshedAt` × 履歴)
- **Scenario × Model 分配マトリクス** (per-scenario 円グラフ or bar)
- **提案文** (親 doc §A の suggestion 4種類 — primary が未到達、fallback 過度依存、rule ヒット率低、tier 不一致)
- 各提案の「SQL を表示」→ 実際には Preference JSON diff を表示 (親 doc §L4 対応で修正済み)

### 依存関係

- Phase 5 の scheduler-state API
- Phase 1 の `SubAccountQuota` (populated 済み)
- 既存 `RequestLog`

**推定工数**: 3〜5 日、~1200 LOC (Level 2 の親 doc 見積とほぼ同)

---

## Phase 8: Scenario Router 削除

### 前提条件

**`ROUTER_MODE=quota-aware ROUTER_ROLLOUT_PCT=100` で 2〜4週間安定稼働** し、shadow divergence が許容範囲であることを確認してから着手。

### スコープ

以下を削除:

- `src/llms/scenario-router/` ディレクトリ丸ごと
- `src/llms/scenario-router.ts` の `routeScenario` を **quota-aware 専用の薄い wrapper に置換** (fallback 経路も削除)
- `src/schemas/router.dto.ts` の `RouterSlot` / `RouterConfig` / `ScenarioType` / `RouteRule` — RouterSlot テーブルに書き込む API が消えるので schema 側も撤去
- **Prisma migration**: `RouterSlot` テーブルを `DROP TABLE`。参照が残ってないか事前に grep 必須
- `/api/config` の `Router` フィールドを撤去 or preferences に置換
- `/api/routing-presets` — RouterSlot を対象にしていたので撤去 or preferences preset に置換
- UI 側: `src/routes/router` の scenario 編集タブ削除、Preference editor だけ残す
- 関連テスト大量 (~990 行の `__tests__/llms/scenario-router.test.ts` 等)

### 移行ハザード

- **既存 preset (routing-preset.ts)** が RouterSlot 前提で書かれている。preset → preferences converter を Phase 6 の UI で提供、DB migration script で自動変換 (親 doc §Part B の converter を再利用)
- **project-config** (`getProjectRouter`) が `~/.claude/projects/*/router.json` を読んでいる — このファイル形式も変わる or 廃止
- ダウングレード (v2.52.x → 旧版) は **不可能** になる。plan doc に明記

### 段階リリース

1. **v2.53.0**: `routing-preset` の書き込みを preferences に切替 (RouterSlot は読み取り互換のまま)
2. **v2.54.0**: `/api/config` の Router フィールドを read-only にし、UI の scenario タブを削除
3. **v2.55.0** (削除本命): scenario-router コード削除、`RouterSlot` DROP TABLE migration

### 推定工数

準備 + 削除本体で **1〜2 週**。関連テスト書き直しが最大コスト。

---

## リリース計画

| 版 | 内容 |
|---|---|
| **v2.52.0** (現) | Phase 1〜4 (バックエンド完成、scenario mode 継続) |
| v2.53.0 | Phase 5 (scheduler-state API) |
| v2.54.0 | Phase 6 (Preference editor UI) |
| v2.55.0 | Phase 7 (Utilization dashboard) |
| v2.56.0〜v2.58.0 | Phase 8 (段階削除) |

各 Phase は独立して merge/release 可能。**Phase 5 → 6 → 7** の順序は依存関係で決まる (5 の API を 6/7 が消費)。Phase 8 は operations 判断で開始タイミングを決める。

---

## Open Questions (実装前に決めたいもの)

1. **preference editor の scope** — 既存 scenario 編集タブと同居 (segmented UI) か置換か。Phase 8 で消すなら segmented がスムーズ、直で置換ならユーザー学習コスト
2. **preset 互換** — routing-preset の `Router` 形式 preset を preferences 形式にどう変換するか (親 doc §Part B の converter を採用でよいか)
3. **project-config の扱い** — Phase 8 で `~/.claude/projects/*/router.json` を廃止するか、preferences 形式で残すか
4. **Phase 7 の "提案文" ロジック** — 親 doc §Part A の 4 種類でよいか、production data 見て追加候補があるか
5. **Phase 8 の削除タイミング** — 「安定稼働 4 週間」の基準を error rate で数値化するか (例: 429/session < 0.5%)
6. **Phase 5 の polling 頻度** — UI の 30s デフォルトでよいか、user 選択制にするか

---

## Non-goals (含めないもの)

- **multi-instance snapshot 共有** (Redis pub/sub 等) — 親 doc §17 の Open Question #9 が single-process 前提で許容と結論済み
- **preference presets の複数化** — `RouterPreferenceProfile.key='live'` シングルトン継続。preset feature は既存 `RoutingPreset` テーブル側に寄せる
- **`ROUTING_SCHEDULER_INTERVAL_MS` 下限の 60s → 300s 引き上げ** — 親 doc §17 Q8 が Phase 1 データ次第としているので、Phase 7 dashboard で 429 率とキャッシュヒット率が見えてから判断

---

## 依存ドキュメント / コード

- `docs/plan/quota-aware-preference-router.md` §6.3 constraints schema
- `src/services/routing-scheduler/{state,index}.ts` — Phase 5 が読む snapshot 型
- `src/services/router-preference-service.ts` — Phase 6 が呼ぶ apply/load
- `src/components/*` — Phase 6 UI が乗る場所 (shadcn / Tailwind v4)
- `__tests__/db/helpers.ts` — 新規 API テストの DB reset ヘルパ
