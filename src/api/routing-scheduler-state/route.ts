/**
 * Read-only routing scheduler snapshot.
 *
 * Returns whatever the last scheduler tick published — per target
 * ("provider,model" on a subscription provider) whether it is out of
 * quota, how much is left and when it resets, plus per-account quota
 * state and the soonest reset. Cold-boot returns an empty snapshot
 * rather than 404 so the UI can render "no data yet" without a special
 * code path.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import dayjs from '../../lib/dayjs'
import { getRoutingSnapshot } from '../../services/routing-scheduler'

const TargetStateDtoSchema = z
  .object({
    target: z.string().nonempty(),
    exhausted: z.boolean(),
    remainingBudgetPct: z.number().min(0).max(100).nullable(),
    // Projected use at the reset, % of the budget; over 100 steps down.
    projectedPct: z.number().min(0).nullable(),
    resetAt: z.string().nonempty().nullable()
  })
  .openapi('RoutingTargetState')

const QuotaWindowDtoSchema = z
  .object({
    used: z.number(),
    limit: z.number(),
    resetAt: z.string().nonempty().nullable()
  })
  .openapi('RoutingQuotaWindow')

const AccountQuotaViewDtoSchema = z
  .object({
    subAccountId: z.string().nonempty(),
    providerName: z.string().nonempty(),
    kind: z.enum(['claude', 'codex']),
    fiveHour: QuotaWindowDtoSchema.nullable(),
    weekly: QuotaWindowDtoSchema.nullable(),
    refreshedAt: z.string().nonempty().nullable(),
    stale: z.boolean()
  })
  .openapi('RoutingAccountQuotaView')

const SchedulerStateResponseSchema = z
  .object({
    tickAt: z.string().nonempty().nullable(),
    tickCount: z.number().int().min(0),
    consecutiveFailures: z.number().int().min(0),
    degraded: z.boolean(),
    targets: z.array(TargetStateDtoSchema),
    accounts: z.array(AccountQuotaViewDtoSchema),
    soonestResetAt: z.string().nonempty().nullable()
  })
  .openapi('RoutingSchedulerStateResponse')

const isoOrNull = (ms: number | null): string | null => (ms === null ? null : dayjs(ms).toISOString())

const windowDto = (w: { used: number; limit: number; resetAt: number | null } | null) =>
  w === null ? null : { used: w.used, limit: w.limit, resetAt: isoOrNull(w.resetAt) }

export const routingSchedulerStateRoute = new OpenAPIHono()

const getRoute = createRoute({
  method: 'get',
  path: '/api/routing-scheduler-state',
  responses: {
    200: {
      description: 'Current quota snapshot: per-target state and per-account windows',
      content: { 'application/json': { schema: SchedulerStateResponseSchema } }
    }
  }
})

routingSchedulerStateRoute.openapi(getRoute, async (c) => {
  const snap = getRoutingSnapshot()
  if (snap === null) {
    return c.json(
      {
        tickAt: null,
        tickCount: 0,
        consecutiveFailures: 0,
        degraded: false,
        targets: [],
        accounts: [],
        soonestResetAt: null
      },
      200
    )
  }
  return c.json(
    {
      tickAt: dayjs(snap.tickAt).toISOString(),
      tickCount: snap.tickCount,
      consecutiveFailures: snap.consecutiveFailures,
      degraded: snap.degraded,
      targets: [...snap.targets.values()].map((t) => ({
        target: t.target,
        exhausted: t.exhausted,
        remainingBudgetPct: t.remainingBudgetPct,
        projectedPct: t.projectedPct,
        resetAt: isoOrNull(t.resetAt)
      })),
      accounts: snap.accounts.map((a) => ({
        subAccountId: a.subAccountId,
        providerName: a.providerName,
        kind: a.kind,
        fiveHour: windowDto(a.fiveHour),
        weekly: windowDto(a.weekly),
        refreshedAt: isoOrNull(a.refreshedAt),
        stale: a.stale
      })),
      soonestResetAt: isoOrNull(snap.soonestResetAt)
    },
    200
  )
})
