/**
 * Per-account usage at API prices.
 *
 * Pinned: which weekly window an account is in (the vendor's, from its
 * reset time), that a subscription model is priced through the same model
 * name on a priced provider, that "unpriced" and "no traffic" stay
 * different answers, and that each account only ever sees its own rows.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import dayjs from '../../src/lib/dayjs'
import {
  type AccountUsageInput,
  figuresOf,
  usageByAccount,
  valueRatioOf,
  weeklyWindowStart
} from '../../src/services/account-usage-service'
import type { PriceEntry } from '../../src/services/cost-service'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

const NOW = dayjs('2026-09-24T12:00:00.000Z').valueOf()
const HOUR = 3_600_000
const DAY = 24 * HOUR

const account = (over: Partial<AccountUsageInput> = {}): AccountUsageInput => ({
  subAccountId: 'acct-a',
  weeklyResetAt: null,
  weeklyWindowSeconds: null,
  monthlyPriceUsd: null,
  ...over
})

describe('weeklyWindowStart', () => {
  test('a reset ahead of now: the window runs back one length from it', () => {
    const resetAt = dayjs(NOW + 2 * DAY).toDate()
    expect(weeklyWindowStart(account({ weeklyResetAt: resetAt }), NOW)).toBe(NOW + 2 * DAY - 7 * DAY)
  })

  test("Codex reports the window's own length, and it is used", () => {
    const resetAt = dayjs(NOW + HOUR).toDate()
    expect(weeklyWindowStart(account({ weeklyResetAt: resetAt, weeklyWindowSeconds: 3 * 24 * 3600 }), NOW)).toBe(
      NOW + HOUR - 3 * DAY
    )
  })

  test('a reset already past means a new window began at it', () => {
    const resetAt = dayjs(NOW - 5 * HOUR).toDate()
    expect(weeklyWindowStart(account({ weeklyResetAt: resetAt }), NOW)).toBe(NOW - 5 * HOUR)
  })

  test('no reading: the trailing week', () => {
    expect(weeklyWindowStart(account(), NOW)).toBe(NOW - 7 * DAY)
  })
})

describe('figuresOf / valueRatioOf', () => {
  const PRICES = new Map<string, PriceEntry>([
    ['anthropic||claude-sonnet-5', { inputPer1M: 3, outputPer1M: 15, cachedInputPer1M: 0.3 }]
  ])
  const group = (model: string, inputTokens: number, outputTokens: number) => ({
    subAccountId: 'acct-a',
    provider: 'anthropic',
    model,
    requests: 1,
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0
  })

  test('sums tokens and prices each model', () => {
    const figures = figuresOf([group('claude-sonnet-5', 1_000_000, 1_000_000)], PRICES)
    expect(figures).toMatchObject({ requests: 1, totalTokens: 2_000_000 })
    expect(figures.costUsd).toBeCloseTo(18, 6)
  })

  test('traffic with no price anywhere is unknown, not free', () => {
    expect(figuresOf([group('mystery-1', 10, 10)], PRICES).costUsd).toBeNull()
  })

  test('no traffic costs nothing', () => {
    expect(figuresOf([], PRICES).costUsd).toBe(0)
  })

  test('an unpriced model does not void the part that priced', () => {
    const figures = figuresOf([group('claude-sonnet-5', 1_000_000, 0), group('mystery-1', 5, 5)], PRICES)
    expect(figures.costUsd).toBeCloseTo(3, 6)
  })

  test('the ratio needs both a cost and a fee', () => {
    expect(valueRatioOf(300, 200)).toBeCloseTo(1.5, 6)
    expect(valueRatioOf(null, 200)).toBeNull()
    expect(valueRatioOf(300, null)).toBeNull()
    expect(valueRatioOf(300, 0)).toBeNull()
  })
})

describe.skipIf(!HAS_DB)('usageByAccount', () => {
  beforeEach(async () => {
    await resetDbTables()
  })

  afterAll(teardownPrisma)

  const seed = async (): Promise<void> => {
    const prisma = getPrismaClient()
    // The subscription provider has no price of its own; the api_key
    // provider's price for the same model name is what the API
    // equivalent reads.
    const priced = await prisma.provider.create({
      data: { name: 'anthropic', apiBaseUrl: 'https://api.anthropic.com', authMode: 'api_key' }
    })
    await prisma.model.create({
      data: { providerId: priced.id, name: 'claude-sonnet-5', inputPer1M: 3, outputPer1M: 15, cachedInputPer1M: 0.3 }
    })
    await prisma.session.create({ data: { id: 'sess-1' } })
    const row = (subAccountId: string | null, at: number, inputTokens: number) =>
      prisma.requestLog.create({
        data: {
          sessionId: 'sess-1',
          provider: 'claude-code',
          model: 'claude-sonnet-5',
          subAccountId,
          inputTokens,
          outputTokens: 0,
          totalInputTokens: inputTokens,
          createdAt: dayjs(at).toDate()
        }
      })
    await row('acct-a', NOW - 2 * HOUR, 1_000_000) // this week
    await row('acct-a', NOW - 10 * DAY, 2_000_000) // 30 days, not this week
    await row('acct-a', NOW - 40 * DAY, 9_000_000) // outside both
    await row('acct-b', NOW - HOUR, 500_000) // another account
    await row(null, NOW - HOUR, 7_000_000) // api_key traffic: no account
  }

  test("splits each account's traffic into its week and its 30 days, priced at API rates", async () => {
    await seed()
    const usage = await usageByAccount([account({ monthlyPriceUsd: 5 }), account({ subAccountId: 'acct-b' })], NOW)
    const a = usage.get('acct-a')
    expect(a?.window.inputTokens).toBe(1_000_000)
    expect(a?.last30d.inputTokens).toBe(3_000_000)
    expect(a?.last30d.requests).toBe(2)
    expect(a?.last30d.costUsd).toBeCloseTo(9, 6)
    expect(a?.valueRatio).toBeCloseTo(1.8, 6)
    expect(usage.get('acct-b')?.last30d.inputTokens).toBe(500_000)
    expect(usage.get('acct-b')?.valueRatio).toBeNull()
  })

  test('an account with no traffic reads zero, not unknown', async () => {
    await seed()
    const usage = await usageByAccount([account({ subAccountId: 'acct-idle' })], NOW)
    expect(usage.get('acct-idle')?.last30d).toMatchObject({ requests: 0, totalTokens: 0, costUsd: 0 })
  })
})
