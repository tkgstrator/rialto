/**
 * Usage windows behind a plan's limits.
 *
 * The properties worth pinning are the ones whose failure lets a limited
 * token spend past its plan, or locks it out after its window has
 * passed: a window opens at the first request and resets a fixed length
 * later (not sliding), a full window refuses by requests and by spend,
 * refusals do not count, and concurrent requests cannot race past a limit
 * — including at the instant a window expires.
 *
 * The clock is moved with `setSystemTime`; the service reads time from
 * dayjs, never from Postgres, so the database sees the faked clock too.
 */
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import dayjs from '../../src/lib/dayjs'
import { invalidateTokenCache, issueAccessToken } from '../../src/services/access-token-service'
import {
  addSpend,
  admitRequest,
  hasAnyLimit,
  type PlanLimits,
  planLimitsOf,
  readUsageWindows,
  recordCallSpend,
  resetUsageWindows
} from '../../src/services/usage-window-service'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

const T0 = Date.parse('2026-09-29T00:00:00.000Z')
const HOUR = 3_600_000

const limits = (over: {
  requests5h?: number
  spend5h?: number
  requests7d?: number
  spend7d?: number
}): PlanLimits => ({
  '5h': {
    requests: over.requests5h === undefined ? null : over.requests5h,
    spendUsd: over.spend5h === undefined ? null : over.spend5h
  },
  '7d': {
    requests: over.requests7d === undefined ? null : over.requests7d,
    spendUsd: over.spend7d === undefined ? null : over.spend7d
  }
})

describe('plan limits', () => {
  test('reads the four plan columns by window', () => {
    expect(
      planLimitsOf({
        fiveHourRequestLimit: 10,
        fiveHourSpendLimitUsd: null,
        sevenDayRequestLimit: null,
        sevenDaySpendLimitUsd: 5
      })
    ).toEqual(limits({ requests5h: 10, spend7d: 5 }))
  })

  test('a plan with every limit empty has none', () => {
    expect(hasAnyLimit(limits({}))).toBe(false)
    expect(hasAnyLimit(limits({ spend7d: 1 }))).toBe(true)
  })
})

describe.skipIf(!HAS_DB)('usage windows', () => {
  const tokenId = { value: '' }

  const rowOf = (window: '5h' | '7d') =>
    getPrismaClient().accessTokenUsageWindow.findUnique({
      where: { accessTokenId_window: { accessTokenId: tokenId.value, window } }
    })

  beforeEach(async () => {
    setSystemTime(dayjs(T0).toDate())
    await resetDbTables()
    await getPrismaClient().$executeRawUnsafe(
      'TRUNCATE "AccessTokenUsageWindow","AccessToken","Plan" RESTART IDENTITY CASCADE'
    )
    invalidateTokenCache()
    tokenId.value = (await issueAccessToken({ name: 'limited' })).token.id
  })

  afterEach(() => {
    setSystemTime()
  })

  afterAll(teardownPrisma)

  test('the first request opens both windows, and later ones count in them', async () => {
    const plan = limits({ requests5h: 10 })
    expect(await admitRequest(tokenId.value, plan)).toEqual({ outcome: 'allowed' })
    setSystemTime(dayjs(T0 + HOUR).toDate())
    expect(await admitRequest(tokenId.value, plan)).toEqual({ outcome: 'allowed' })

    for (const window of ['5h', '7d'] as const) {
      const row = await rowOf(window)
      // Opened at the first request, not moved by the second.
      expect(row?.startedAt.toISOString()).toBe('2026-09-29T00:00:00.000Z')
      expect(row?.requests).toBe(2)
    }
    const report = await readUsageWindows(tokenId.value, plan)
    expect(report[0]).toEqual({
      window: '5h',
      startedAt: '2026-09-29T00:00:00.000Z',
      resetsAt: '2026-09-29T05:00:00.000Z',
      requests: 2,
      requestLimit: 10,
      costUsd: 0,
      spendLimitUsd: null
    })
    expect(report[1].resetsAt).toBe('2026-10-06T00:00:00.000Z')
  })

  test('a full window refuses until it resets, and the refusal is not counted', async () => {
    const plan = limits({ requests5h: 2 })
    await admitRequest(tokenId.value, plan)
    await admitRequest(tokenId.value, plan)
    setSystemTime(dayjs(T0 + 2 * HOUR).toDate())
    const refused = await admitRequest(tokenId.value, plan)
    expect(refused).toEqual({
      outcome: 'exhausted',
      window: '5h',
      by: 'requests',
      resetsAt: '2026-09-29T05:00:00.000Z',
      retryAfterSeconds: 3 * 3600
    })
    await admitRequest(tokenId.value, plan)
    expect((await rowOf('5h'))?.requests).toBe(2)

    // One instant before the reset it is still full; at the reset it is over.
    setSystemTime(dayjs(T0 + 5 * HOUR - 1).toDate())
    expect((await admitRequest(tokenId.value, plan)).outcome).toBe('exhausted')
    setSystemTime(dayjs(T0 + 5 * HOUR).toDate())
    expect(await admitRequest(tokenId.value, plan)).toEqual({ outcome: 'allowed' })

    const fiveHour = await rowOf('5h')
    expect(fiveHour?.startedAt.toISOString()).toBe('2026-09-29T05:00:00.000Z')
    expect(fiveHour?.requests).toBe(1)
    // The 7-day window keeps counting across the 5-hour reset.
    expect((await rowOf('7d'))?.requests).toBe(3)
  })

  test('the 7-day window holds after the 5-hour one resets, and resets after 7 days', async () => {
    const plan = limits({ requests5h: 5, requests7d: 2 })
    await admitRequest(tokenId.value, plan)
    await admitRequest(tokenId.value, plan)

    setSystemTime(dayjs(T0 + 6 * HOUR).toDate())
    const refused = await admitRequest(tokenId.value, plan)
    expect(refused).toMatchObject({ outcome: 'exhausted', window: '7d', resetsAt: '2026-10-06T00:00:00.000Z' })

    setSystemTime(dayjs(T0 + 7 * 24 * HOUR).toDate())
    expect(await admitRequest(tokenId.value, plan)).toEqual({ outcome: 'allowed' })
    expect((await rowOf('7d'))?.requests).toBe(1)
  })

  test('when both windows are full the refusal names the later reset', async () => {
    const plan = limits({ requests5h: 1, requests7d: 1 })
    await admitRequest(tokenId.value, plan)
    expect(await admitRequest(tokenId.value, plan)).toMatchObject({ outcome: 'exhausted', window: '7d' })
  })

  test('spend fills a window: the call that crosses the limit completes, the next is refused', async () => {
    const plan = limits({ spend5h: 1 })
    expect((await admitRequest(tokenId.value, plan)).outcome).toBe('allowed')
    await addSpend(tokenId.value, 0.6)
    expect((await admitRequest(tokenId.value, plan)).outcome).toBe('allowed')
    await addSpend(tokenId.value, 0.6)
    expect(await admitRequest(tokenId.value, plan)).toMatchObject({ outcome: 'exhausted', window: '5h', by: 'spend' })
    expect((await rowOf('5h'))?.costUsd).toBeCloseTo(1.2, 9)
    expect((await rowOf('7d'))?.costUsd).toBeCloseTo(1.2, 9)
  })

  test('spend goes only to windows still open', async () => {
    await admitRequest(tokenId.value, limits({ spend7d: 100 }))
    setSystemTime(dayjs(T0 + 6 * HOUR).toDate())
    await addSpend(tokenId.value, 2)
    expect((await rowOf('5h'))?.costUsd).toBe(0)
    expect((await rowOf('7d'))?.costUsd).toBe(2)
    // A lapsed window reads as empty rather than as its old totals.
    expect((await readUsageWindows(tokenId.value, limits({ spend7d: 100 })))[0]).toMatchObject({
      startedAt: null,
      requests: 0,
      costUsd: 0
    })
  })

  test('removing all limits hides stored usage without deleting it', async () => {
    await admitRequest(tokenId.value, limits({ requests5h: 1 }))
    for (const plan of [null, limits({})]) {
      const report = await readUsageWindows(tokenId.value, plan)
      expect(report.every((window) => window.startedAt === null && window.requests === 0 && window.costUsd === 0)).toBe(
        true
      )
    }
    expect((await rowOf('5h'))?.requests).toBe(1)
  })

  test('spend at completion belongs to the newly opened window, not the expired one', async () => {
    const plan = limits({ spend5h: 10 })
    await admitRequest(tokenId.value, plan)
    setSystemTime(dayjs(T0 + 5 * HOUR).toDate())
    await admitRequest(tokenId.value, plan)
    await addSpend(tokenId.value, 2)
    expect((await rowOf('5h'))?.costUsd).toBe(2)
    expect((await rowOf('7d'))?.costUsd).toBe(2)
  })

  test('resets racing admission and spend never leave half a pair of windows', async () => {
    const plan = limits({ requests5h: 100 })
    for (const resetTarget of [tokenId.value, null]) {
      await Promise.all([admitRequest(tokenId.value, plan), addSpend(tokenId.value, 1), resetUsageWindows(resetTarget)])
      const fiveHour = await rowOf('5h')
      const sevenDay = await rowOf('7d')
      expect(fiveHour?.requests).toBe(sevenDay?.requests)
      expect(fiveHour?.costUsd).toBe(sevenDay?.costUsd)
    }
  })

  test('a completed call is priced the way the Cost column prices it', async () => {
    const prisma = getPrismaClient()
    const provider = await prisma.provider.create({
      data: { name: 'anthropic', apiBaseUrl: 'https://api.anthropic.com', authMode: 'api_key', apiStyle: 'anthropic' }
    })
    await prisma.model.create({
      data: { providerId: provider.id, name: 'claude-sonnet', enabled: true, inputPer1M: 3, outputPer1M: 15 }
    })
    const call = {
      accessTokenId: tokenId.value,
      provider: 'anthropic',
      model: 'claude-sonnet',
      inputTokens: 100_000,
      outputTokens: 10_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0
    }
    // No open window: nothing to add to, and nothing is opened.
    await recordCallSpend(call)
    expect(await rowOf('5h')).toBeNull()

    await admitRequest(tokenId.value, limits({ spend5h: 10 }))
    await recordCallSpend(call)
    // 0.1M input at $3 + 0.01M output at $15.
    expect((await rowOf('5h'))?.costUsd).toBeCloseTo(0.45, 9)
    // An unpriced model (every subscription model) adds nothing.
    await recordCallSpend({ ...call, provider: 'codex', model: 'gpt-5.5' })
    expect((await rowOf('5h'))?.costUsd).toBeCloseTo(0.45, 9)
  })

  test('concurrent requests on a fresh token admit exactly the limit', async () => {
    const plan = limits({ requests5h: 5 })
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => admitRequest(tokenId.value, plan)))
    expect(outcomes.filter((o) => o.outcome === 'allowed')).toHaveLength(5)
    expect(outcomes.filter((o) => o.outcome === 'exhausted')).toHaveLength(15)
    expect((await rowOf('5h'))?.requests).toBe(5)
  })

  test('concurrent requests at the instant a window resets restart it once and admit exactly the limit', async () => {
    const plan = limits({ requests5h: 3 })
    await admitRequest(tokenId.value, plan)
    await admitRequest(tokenId.value, plan)
    await admitRequest(tokenId.value, plan)
    setSystemTime(dayjs(T0 + 5 * HOUR).toDate())
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => admitRequest(tokenId.value, plan)))
    expect(outcomes.filter((o) => o.outcome === 'allowed')).toHaveLength(3)
    const row = await rowOf('5h')
    expect(row?.startedAt.toISOString()).toBe('2026-09-29T05:00:00.000Z')
    expect(row?.requests).toBe(3)
  })

  test("reset clears one token's windows, or everyone's", async () => {
    const other = (await issueAccessToken({ name: 'other' })).token.id
    const plan = limits({ requests5h: 1 })
    await admitRequest(tokenId.value, plan)
    await admitRequest(other, plan)

    expect(await resetUsageWindows(tokenId.value)).toBe(2)
    expect(await rowOf('5h')).toBeNull()
    expect(await getPrismaClient().accessTokenUsageWindow.count({ where: { accessTokenId: other } })).toBe(2)
    // Its next request is admitted into a fresh window.
    expect((await admitRequest(tokenId.value, plan)).outcome).toBe('allowed')

    expect(await resetUsageWindows(null)).toBe(4)
    expect(await getPrismaClient().accessTokenUsageWindow.count()).toBe(0)
  })
})
