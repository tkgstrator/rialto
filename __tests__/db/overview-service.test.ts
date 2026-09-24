/**
 * Overview aggregation.
 *
 * The subtle part is the surface breakdown. `RequestLog.surface` is
 * nullable — rows written before the column landed cannot be attributed
 * to a surface, and 'openai' covers two of them — so the screen has to
 * exclude untracked rows from per-surface traffic rather than dump them
 * into a bucket. These tests pin that, plus the distinction between "no
 * traffic" (null latency / null error rate) and "traffic with zero
 * errors" (0), which the mock renders differently on purpose.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import dayjs from '../../src/lib/dayjs'
import { invalidateSurfaceCache } from '../../src/services/inbound-surface-service'
import { getOverview } from '../../src/services/overview-service'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

interface LogSeed {
  surface: string | null
  durationMs: number
  status: number
  minutesAgo?: number
}

async function seedLogs(sessionId: string, logs: LogSeed[]): Promise<void> {
  const prisma = getPrismaClient()
  await prisma.session.upsert({ where: { id: sessionId }, create: { id: sessionId }, update: {} })
  for (const [i, log] of logs.entries()) {
    const minutes = log.minutesAgo === undefined ? i : log.minutesAgo
    await prisma.requestLog.create({
      data: {
        sessionId,
        provider: 'acme',
        model: 'acme-1',
        surface: log.surface,
        durationMs: log.durationMs,
        status: log.status,
        inputTokens: 10,
        outputTokens: 5,
        totalInputTokens: 10,
        createdAt: new Date(Date.now() - minutes * 60_000)
      }
    })
  }
}

const bySurface = (surfaces: Awaited<ReturnType<typeof getOverview>>['surfaces'], id: string) =>
  surfaces.find((s) => s.id === id)

describe.skipIf(!HAS_DB)('getOverview', () => {
  beforeEach(async () => {
    await resetDbTables()
    invalidateSurfaceCache()
  })

  afterAll(teardownPrisma)

  test('lists every registered surface even when none has traffic', async () => {
    const out = await getOverview(24)
    expect(out.surfaces.map((s) => s.id)).toEqual([
      'anthropic-messages',
      'openai-chat',
      'openai-responses',
      'gemini-generate'
    ])
    expect(out.surfaces.every((s) => s.requests === 0)).toBe(true)
  })

  test('a surface with no traffic reports no latency and no error rate, not zero', async () => {
    const out = await getOverview(24)
    const messages = bySurface(out.surfaces, 'anthropic-messages')
    expect(messages?.p50Ms).toBeNull()
    expect(messages?.errorRate).toBeNull()
  })

  test('traffic with no failures reports a zero error rate, which is not the same as none', async () => {
    await seedLogs('s1', [
      { surface: 'anthropic-messages', durationMs: 100, status: 200 },
      { surface: 'anthropic-messages', durationMs: 300, status: 200 }
    ])
    const messages = bySurface((await getOverview(24)).surfaces, 'anthropic-messages')
    expect(messages?.requests).toBe(2)
    expect(messages?.errorRate).toBe(0)
  })

  test('untracked rows are excluded from every surface rather than bucketed into one', async () => {
    await seedLogs('s1', [
      { surface: null, durationMs: 100, status: 200 },
      { surface: null, durationMs: 100, status: 200 },
      { surface: 'openai-chat', durationMs: 100, status: 200 }
    ])
    const out = await getOverview(24)
    expect(bySurface(out.surfaces, 'openai-chat')?.requests).toBe(1)
    expect(bySurface(out.surfaces, 'openai-responses')?.requests).toBe(0)
    expect(bySurface(out.surfaces, 'anthropic-messages')?.requests).toBe(0)
  })

  test('the two OpenAI-compat surfaces are counted separately', async () => {
    await seedLogs('s1', [
      { surface: 'openai-chat', durationMs: 100, status: 200 },
      { surface: 'openai-responses', durationMs: 100, status: 200 },
      { surface: 'openai-responses', durationMs: 100, status: 200 }
    ])
    const out = await getOverview(24)
    expect(bySurface(out.surfaces, 'openai-chat')?.requests).toBe(1)
    expect(bySurface(out.surfaces, 'openai-responses')?.requests).toBe(2)
  })

  test('p50 averages the middle pair so a slow outlier is not reported as typical', async () => {
    await seedLogs('s1', [
      { surface: 'anthropic-messages', durationMs: 100, status: 200 },
      { surface: 'anthropic-messages', durationMs: 200, status: 200 },
      { surface: 'anthropic-messages', durationMs: 300, status: 200 },
      { surface: 'anthropic-messages', durationMs: 9000, status: 200 }
    ])
    expect(bySurface((await getOverview(24)).surfaces, 'anthropic-messages')?.p50Ms).toBe(250)
  })

  test('the error rate counts every non-2xx status, not only 429', async () => {
    await seedLogs('s1', [
      { surface: 'anthropic-messages', durationMs: 100, status: 200 },
      { surface: 'anthropic-messages', durationMs: 100, status: 429 },
      { surface: 'anthropic-messages', durationMs: 100, status: 500 },
      { surface: 'anthropic-messages', durationMs: 100, status: 200 }
    ])
    expect(bySurface((await getOverview(24)).surfaces, 'anthropic-messages')?.errorRate).toBe(0.5)
  })

  test('traffic older than the window is excluded', async () => {
    await seedLogs('s1', [
      { surface: 'anthropic-messages', durationMs: 100, status: 200, minutesAgo: 30 },
      { surface: 'anthropic-messages', durationMs: 100, status: 200, minutesAgo: 60 * 30 }
    ])
    expect(bySurface((await getOverview(1)).surfaces, 'anthropic-messages')?.requests).toBe(1)
  })

  test('a routing-mode override shows up on the surface row', async () => {
    const prisma = getPrismaClient()
    await prisma.inboundSurfaceConfig.create({
      data: { surface: 'openai-chat', routingMode: 'routed' }
    })
    invalidateSurfaceCache()
    const out = await getOverview(24)
    expect(bySurface(out.surfaces, 'openai-chat')?.routingMode).toBe('routed')
    expect(bySurface(out.surfaces, 'openai-responses')?.routingMode).toBe('passthrough')
  })

  test('recent sessions carry the surface of their newest request', async () => {
    await seedLogs('s1', [
      { surface: 'openai-responses', durationMs: 100, status: 200, minutesAgo: 1 },
      { surface: 'openai-responses', durationMs: 100, status: 200, minutesAgo: 5 }
    ])
    const out = await getOverview(24)
    expect(out.recentSessions).toHaveLength(1)
    expect(out.recentSessions[0].sessionId).toBe('s1')
    expect(out.recentSessions[0].surface).toBe('openai-responses')
    expect(out.recentSessions[0].turns).toBe(2)
  })

  test('spend prices each period from the aggregate and compares against the one before it', async () => {
    const prisma = getPrismaClient()
    // Per-1M prices chosen so a row's cost is a whole number: each log
    // carries 10 input and 5 output tokens, so a price of 1e6 per 1M
    // makes one row cost exactly 15 USD.
    const provider = await prisma.provider.create({
      data: { name: 'acme', apiBaseUrl: 'https://acme.example.com' }
    })
    await prisma.model.create({
      data: { providerId: provider.id, name: 'acme-1', inputPer1M: 1_000_000, outputPer1M: 1_000_000 }
    })
    await seedLogs('s1', [
      { surface: 'anthropic-messages', durationMs: 100, status: 200, minutesAgo: 0 },
      { surface: 'anthropic-messages', durationMs: 100, status: 200, minutesAgo: 0 },
      // One clock-day back: before today's midnight, after the midnight
      // before it, so it lands in today's comparison period and nowhere
      // near the boundary whatever time the suite runs at.
      { surface: 'anthropic-messages', durationMs: 100, status: 200, minutesAgo: 60 * 24 }
    ])

    const spend = (await getOverview(24)).spend
    // Summing tokens per (provider, model) and pricing once must give
    // the same figure as pricing every row and summing — the property
    // that lets the 60-day window be aggregated in SQL.
    expect(spend.find((s) => s.label === 'today')?.usd).toBeCloseTo(30, 6)
    expect(spend.find((s) => s.label === 'month')?.usd).toBeCloseTo(45, 6)
    // 30 today against 15 the day before.
    expect(spend.find((s) => s.label === 'today')?.deltaRatio).toBeCloseTo(1, 6)
    // Nothing precedes the 7- and 30-day windows here, so their deltas
    // stay null rather than reading as an infinite rise.
    expect(spend.find((s) => s.label === 'week')?.deltaRatio).toBeNull()
  })

  test('spend reports no delta when the previous period had nothing to compare against', async () => {
    await seedLogs('s1', [{ surface: 'anthropic-messages', durationMs: 100, status: 200 }])
    const out = await getOverview(24)
    // No Model row exists for acme-1, so nothing is priced and every
    // tile is null — including the delta, which must not read as 0%.
    expect(out.spend.every((s) => s.deltaRatio === null)).toBe(true)
    expect(out.spend.find((s) => s.label === 'savedBySubscription')?.usd).toBeNull()
  })
})

describe.skipIf(!HAS_DB)('getOverview — what each account carried', () => {
  beforeEach(async () => {
    await resetDbTables()
    invalidateSurfaceCache()
  })

  afterAll(teardownPrisma)

  test("a quota row carries the account's usage at API prices beside its windows", async () => {
    const prisma = getPrismaClient()
    const sub = await prisma.provider.create({
      data: { name: 'claude-code', apiBaseUrl: 'https://api.anthropic.com', authMode: 'subscription' }
    })
    const priced = await prisma.provider.create({
      data: { name: 'anthropic', apiBaseUrl: 'https://api.anthropic.com', authMode: 'api_key' }
    })
    await prisma.model.create({
      data: { providerId: priced.id, name: 'claude-sonnet-5', inputPer1M: 3, outputPer1M: 15 }
    })
    const acct = await prisma.subAccount.create({
      data: { providerId: sub.id, sourcePath: 'oauth:test:anna', label: 'anna', monthlyPriceUsd: 100 }
    })
    await prisma.subAccountQuota.create({
      data: {
        subAccountId: acct.id,
        weeklyUsed: 40,
        weeklyLimit: 100,
        weeklyResetAt: dayjs().add(3, 'day').toDate()
      }
    })
    await prisma.session.create({ data: { id: 'sess-q' } })
    await prisma.requestLog.create({
      data: {
        sessionId: 'sess-q',
        provider: 'claude-code',
        model: 'claude-sonnet-5',
        subAccountId: acct.id,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalInputTokens: 1_000_000
      }
    })

    const out = await getOverview(24)
    const row = out.quota.find((q) => q.subAccountId === acct.id)
    expect(row?.windows.length).toBeGreaterThan(0)
    expect(row?.usage?.window.totalTokens).toBe(2_000_000)
    // 1M in at $3 + 1M out at $15, priced through the api_key provider.
    expect(row?.usage?.last30d.costUsd).toBeCloseTo(18, 6)
    expect(row?.usage?.valueRatio).toBeCloseTo(0.18, 6)
  })
  test('the failover feed lists 429s and rejected credentials, newest first, and nothing about weights', async () => {
    const prisma = getPrismaClient()
    const on = await prisma.provider.create({
      data: { name: 'claude-code', apiBaseUrl: 'https://api.anthropic.com', authMode: 'subscription' }
    })
    const off = await prisma.provider.create({
      data: { name: 'codex', apiBaseUrl: 'https://chatgpt.com/backend-api', authMode: 'subscription', enabled: false }
    })
    const limited = await prisma.subAccount.create({
      data: { providerId: on.id, sourcePath: 'oauth:test:limited', label: 'limited' }
    })
    await prisma.subAccountQuota.create({
      data: {
        subAccountId: limited.id,
        lastRateLimitedAt: dayjs().subtract(2, 'hour').toDate(),
        lastRateLimitStatus: 429,
        lastRetryAfterSec: 660
      }
    })
    await prisma.subAccount.create({
      data: {
        providerId: on.id,
        sourcePath: 'oauth:test:revoked',
        label: 'revoked',
        authStatus: 'invalid',
        authCheckedAt: dayjs().subtract(1, 'hour').toDate(),
        authError: 'refresh token rejected'
      }
    })
    // A credential nobody routes through is not a failover event.
    await prisma.subAccount.create({
      data: {
        providerId: off.id,
        sourcePath: 'oauth:test:parked',
        label: 'parked',
        authStatus: 'invalid',
        authCheckedAt: dayjs().toDate()
      }
    })

    const out = await getOverview(24)
    expect(out.failover.map((f) => [f.kind, f.account])).toEqual([
      ['auth', 'revoked'],
      ['rate_limit', 'limited']
    ])
    expect(out.failover[0].error).toBe('refresh token rejected')
    expect(out.failover[1].retryAfterSec).toBe(660)
  })
})
