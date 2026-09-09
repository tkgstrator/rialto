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

const QuotaSchema = z
  .object({
    subAccountId: z.string().nonempty(),
    account: z.string().nonempty(),
    // Every limit the account is under, shortest window first. An account
    // has several and any one of them hitting 100% stops it.
    windows: z.array(QuotaWindowSchema)
  })
  .openapi('OverviewQuota')

const FailoverSchema = z
  .object({
    kind: z.enum(['rate_limit', 'weight']),
    tone: z.enum(['bad', 'warn', 'mute']),
    at: z.string().min(0),
    // Fields, not prose: the sentence is composed and translated on the
    // UI side. See FailoverRow in services/overview-service.ts.
    account: z.string().nonempty().nullable(),
    status: z.number().int().nullable(),
    retryAfterSec: z.number().int().nullable(),
    target: z.string().nonempty().nullable(),
    fromWeight: z.number().nullable(),
    toWeight: z.number().nullable(),
    reason: z.string().nonempty().nullable()
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
