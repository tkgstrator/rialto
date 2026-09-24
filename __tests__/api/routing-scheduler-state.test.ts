import { afterEach, beforeEach, expect, test } from 'bun:test'
import { z } from 'zod'
import { routingSchedulerStateRoute } from '../../src/api/routing-scheduler-state/route'
import dayjs from '../../src/lib/dayjs'
import { __resetSchedulerStateForTest, publishSnapshot } from '../../src/services/routing-scheduler/state'
import type { RoutingSnapshot } from '../../src/services/routing-scheduler/types'

beforeEach(() => {
  __resetSchedulerStateForTest()
})
afterEach(() => {
  __resetSchedulerStateForTest()
})

const call = async (): Promise<Response> =>
  routingSchedulerStateRoute.fetch(new Request('http://local/api/routing-scheduler-state'))

const BodySchema = z.object({
  tickAt: z.string().nullable(),
  tickCount: z.number(),
  degraded: z.boolean(),
  soonestResetAt: z.string().nullable(),
  targets: z.array(
    z.object({
      target: z.string(),
      exhausted: z.boolean(),
      remainingBudgetPct: z.number().nullable(),
      projectedPct: z.number().nullable(),
      resetAt: z.string().nullable()
    })
  ),
  accounts: z.array(z.object({ subAccountId: z.string(), fiveHour: z.object({ resetAt: z.string() }).nullable() }))
})

const bodyOf = async (res: Response) => {
  const parsed = BodySchema.safeParse(await res.json())
  if (!parsed.success) throw new Error(`unexpected response shape: ${parsed.error.message}`)
  return parsed.data
}

test('cold-boot returns an empty snapshot rather than 404', async () => {
  const res = await call()
  expect(res.status).toBe(200)
  const body = await bodyOf(res)
  expect(body.tickAt).toBeNull()
  expect(body.tickCount).toBe(0)
  expect(body.targets).toEqual([])
  expect(body.accounts).toEqual([])
})

test('published snapshot serialises each target with ISO timestamps', async () => {
  const tickAt = 1_700_000_000_000
  const reset = 1_700_000_060_000
  const snap: RoutingSnapshot = {
    tickAt,
    tickCount: 3,
    consecutiveFailures: 0,
    degraded: false,
    targets: new Map([
      [
        'claude-code,claude-fable-5',
        {
          target: 'claude-code,claude-fable-5',
          exhausted: true,
          remainingBudgetPct: 0,
          projectedPct: 134.5,
          resetAt: reset
        }
      ],
      [
        'claude-code,claude-sonnet-5',
        {
          target: 'claude-code,claude-sonnet-5',
          exhausted: false,
          remainingBudgetPct: 55,
          projectedPct: null,
          resetAt: null
        }
      ]
    ]),
    accounts: [
      {
        subAccountId: 'sa1',
        providerName: 'claude-code',
        kind: 'claude',
        fiveHour: { used: 45, limit: 100, resetAt: reset, windowLengthMs: 5 * 60 * 60 * 1000 },
        weekly: null,
        refreshedAt: tickAt,
        stale: false
      }
    ],
    soonestResetAt: reset
  }
  publishSnapshot(snap)
  const body = await bodyOf(await call())
  expect(body.tickCount).toBe(3)
  expect(body.tickAt).toBe(dayjs(tickAt).toISOString())
  expect(body.soonestResetAt).toBe(dayjs(reset).toISOString())
  // The pace is served as the scheduler computed it — over 100 is a
  // target on course to run out — and null while it cannot be judged.
  expect(body.targets).toEqual([
    {
      target: 'claude-code,claude-fable-5',
      exhausted: true,
      remainingBudgetPct: 0,
      projectedPct: 134.5,
      resetAt: dayjs(reset).toISOString()
    },
    {
      target: 'claude-code,claude-sonnet-5',
      exhausted: false,
      remainingBudgetPct: 55,
      projectedPct: null,
      resetAt: null
    }
  ])
  expect(body.accounts[0].fiveHour?.resetAt).toBe(dayjs(reset).toISOString())
})
