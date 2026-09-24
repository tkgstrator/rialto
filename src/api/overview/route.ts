/**
 * GET /api/overview — everything the Overview screen renders.
 *
 * One endpoint rather than five, because the screen is a single summary
 * and five parallel round-trips would let its blocks disagree about which
 * instant they describe.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { getOverview } from '../../services/overview-service'

const SurfaceTrafficSchema = z
  .object({
    id: z.string().nonempty(),
    path: z.string().nonempty(),
    client: z.string().nonempty(),
    routingMode: z.enum(['routed', 'passthrough']),
    requests: z.number().int().nonnegative(),
    p50Ms: z.number().int().nonnegative().nullable(),
    errorRate: z.number().min(0).max(1).nullable()
  })
  .openapi('OverviewSurfaceTraffic')

const SpendSchema = z
  .object({
    label: z.enum(['today', 'week', 'month', 'savedBySubscription']),
    usd: z.number().nullable(),
    deltaRatio: z.number().nullable()
  })
  .openapi('OverviewSpend')

const QuotaWindowSchema = z
  .object({
    // The window's own length. The per-model rows are also '7d'; `scope`
    // is what tells them apart.
    window: z.string().nonempty(),
    scope: z.string().nonempty().nullable(),
    pct: z.number().min(0).max(100),
    resetAt: z.string().nonempty().nullable()
  })
  .openapi('OverviewQuotaWindow')

// What an account carried over one span, at the models' API prices —
// "API equivalent", never a bill. `costUsd` is null when traffic exists
// but none of it could be priced, and 0 when there was no traffic.
const UsageFiguresSchema = z
  .object({
    requests: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    costUsd: z.number().nullable()
  })
  .openapi('OverviewUsageFigures')

const AccountUsageSchema = z
  .object({
    // Start of the weekly window the account is in now, as its vendor
    // meters it — the span `window` covers.
    windowStart: z.string().nonempty(),
    window: UsageFiguresSchema,
    last30d: UsageFiguresSchema,
    monthlyPriceUsd: z.number().nullable(),
    // 30-day API-equivalent cost over the plan's monthly price; null when
    // either is unknown.
    valueRatio: z.number().nullable()
  })
  .openapi('OverviewAccountUsage')

const QuotaSchema = z
  .object({
    subAccountId: z.string().nonempty(),
    account: z.string().nonempty(),
    // Every limit the account is under, shortest window first. An account
    // has several and any one of them hitting 100% stops it.
    windows: z.array(QuotaWindowSchema),
    // Null only when the usage aggregate could not be read; the quota
    // windows above do not depend on it.
    usage: AccountUsageSchema.nullable(),
    // Banked rate-limit resets, Codex accounts only (null otherwise, and
    // before the first poll). `applicable` is how many the vendor would
    // accept right now — 0 while no window is spent.
    resetCredits: z
      .object({
        available: z.number().int().nonnegative(),
        applicable: z.number().int().nonnegative().nullable()
      })
      .nullable()
  })
  .openapi('OverviewQuota')

const FailoverSchema = z
  .object({
    kind: z.enum(['rate_limit', 'auth']),
    tone: z.enum(['bad', 'warn', 'mute']),
    at: z.string().min(0),
    // Fields, not prose: the sentence is composed and translated on the
    // UI side. See FailoverRow in services/overview-service.ts.
    account: z.string().nonempty(),
    status: z.number().int().nullable(),
    retryAfterSec: z.number().int().nullable(),
    error: z.string().nullable()
  })
  .openapi('OverviewFailover')

const RecentSessionSchema = z
  .object({
    sessionId: z.string().nonempty(),
    surface: z.string().nonempty().nullable(),
    model: z.string().nonempty(),
    turns: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    costUsd: z.number().nullable(),
    lastAt: z.string().nonempty()
  })
  .openapi('OverviewRecentSession')

const ResponseSchema = z
  .object({
    windowHours: z.number().int().positive(),
    generatedAt: z.string().nonempty(),
    providerCount: z.number().int().nonnegative(),
    enabledModelCount: z.number().int().nonnegative(),
    surfaces: z.array(SurfaceTrafficSchema),
    spend: z.array(SpendSchema),
    quota: z.array(QuotaSchema),
    failover: z.array(FailoverSchema),
    recentSessions: z.array(RecentSessionSchema)
  })
  .openapi('OverviewResponse')

export const overviewRoute = new OpenAPIHono()

overviewRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/overview',
    request: {
      query: z.object({
        windowHours: z.coerce
          .number()
          .int()
          .positive()
          .max(24 * 30)
          .default(24)
      })
    },
    responses: {
      200: {
        description: 'Traffic, spend, quota and failover summary for the requested window',
        content: { 'application/json': { schema: ResponseSchema } }
      }
    }
  }),
  async (c) => {
    const { windowHours } = c.req.valid('query')
    return c.json(await getOverview(windowHours), 200)
  }
)
