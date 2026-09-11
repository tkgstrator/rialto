/**
 * `forceRefresh` on the usage fetch path.
 *
 * The poller and /api/usage read through a 5-minute per-account cache;
 * the Subscriptions list's Refresh button is the one caller allowed past
 * it. These pin down that the flag skips the TTL check and nothing else:
 * the default path keeps serving the cache, a forced pass re-caches what
 * it fetched, a failed forced call keeps the last value but names the
 * account, and an account on a disabled provider is never polled,
 * forced or not.
 *
 * DB-gated: the accounts come from the real token reader.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import { AuthMode } from '../../src/generated/prisma/client'
import dayjs from '../../src/lib/dayjs'
import { encryptionKey, encryptString } from '../../src/services/subscription-account-sync/crypto'
import {
  __clearUsageCachesForTest,
  __seedClaudeCacheForTest,
  type ClaudeUsage,
  fetchUsageSnapshot,
  fetchUsageSnapshotWithAccountIds
} from '../../src/services/usage-service'
import { HAS_DB, resetDbTables, teardownPrisma } from '../db/helpers'

const TEST_KEY_HEX = 'ab'.repeat(32)
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

const originalFetch = globalThis.fetch
const tokensCalled: string[] = []

const FIXED_BODY = { five_hour: { utilization: 42, resets_at: '2099-01-01T05:00:00.000Z' } }

// Answer the Claude usage endpoint with a fixed 42% five-hour window (or
// a 500 when asked to fail, or the given body) and record which token asked.
const stubUsage = (status = 200, answer: object = FIXED_BODY): void => {
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url !== CLAUDE_USAGE_URL) throw new Error(`unexpected upstream call: ${url}`)
    const auth = new Headers(init?.headers).get('authorization')
    tokensCalled.push(auth === null ? '' : auth.replace(/^Bearer /, ''))
    const body = status === 200 ? answer : {}
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
  globalThis.fetch = Object.assign(fake, { preconnect: originalFetch.preconnect })
}

const seedAccount = async (providerName: string, enabled: boolean, label: string, accessToken: string) => {
  const prisma = getPrismaClient()
  const provider = await prisma.provider.create({
    data: { name: providerName, apiBaseUrl: 'https://api.anthropic.com', authMode: AuthMode.subscription, enabled }
  })
  return prisma.subAccount.create({
    data: {
      providerId: provider.id,
      sourcePath: `oauth:test:${label}`,
      label,
      accessTokenEnc: encryptString(accessToken, encryptionKey()),
      expiresAt: dayjs('2099-01-01T00:00:00.000Z').toDate()
    }
  })
}

const cached = (subAccountId: string): ClaudeUsage => ({
  subAccountId,
  accountLabel: 'anna',
  fiveHour: { utilization: 5, resetsAt: null },
  sevenDay: null,
  sevenDaySonnet: null,
  sevenDayOpus: null,
  weeklyScoped: [],
  extraUsageEnabled: false,
  capturedAt: '2000-01-01T00:00:00.000Z'
})

const fiveHourPct = (usage: ClaudeUsage | undefined): number | null =>
  usage === undefined || usage.fiveHour === null ? null : usage.fiveHour.utilization

describe.skipIf(!HAS_DB)('usage fetch — forceRefresh', () => {
  beforeEach(async () => {
    process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY = TEST_KEY_HEX
    await resetDbTables()
    __clearUsageCachesForTest()
    tokensCalled.length = 0
    stubUsage()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  afterAll(async () => {
    delete process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY
    __clearUsageCachesForTest()
    await teardownPrisma()
  })

  test('the default path serves a cache entry inside the TTL without calling upstream', async () => {
    const anna = await seedAccount('claude-code', true, 'anna', 'tok-anna')
    __seedClaudeCacheForTest(anna.id, cached(anna.id), dayjs().valueOf())

    const { usage } = await fetchUsageSnapshot()
    expect(fiveHourPct(usage.claude[0])).toBe(5)
    expect(tokensCalled).toEqual([])
  })

  test('forceRefresh polls past that same entry and re-caches what it fetched', async () => {
    const anna = await seedAccount('claude-code', true, 'anna', 'tok-anna')
    __seedClaudeCacheForTest(anna.id, cached(anna.id), dayjs().valueOf())

    const forced = await fetchUsageSnapshot({ forceRefresh: true })
    expect(fiveHourPct(forced.usage.claude[0])).toBe(42)
    expect(tokensCalled).toEqual(['tok-anna'])

    // The forced value is now the cached one: the next default read is
    // served from memory, not from upstream again.
    const next = await fetchUsageSnapshot()
    expect(fiveHourPct(next.usage.claude[0])).toBe(42)
    expect(tokensCalled).toEqual(['tok-anna'])
  })

  test('a failed forced call keeps the last cached value and names the account', async () => {
    const anna = await seedAccount('claude-code', true, 'anna', 'tok-anna')
    __seedClaudeCacheForTest(anna.id, cached(anna.id), 0)
    stubUsage(500)

    const paired = await fetchUsageSnapshotWithAccountIds({ forceRefresh: true })
    expect(paired.claude.map((c) => [c.subAccountId, fiveHourPct(c.usage)])).toEqual([[anna.id, 5]])
    expect(paired.failed).toEqual([anna.id])
  })

  test('a spent 5h leaves the other windows as the vendor reported them', async () => {
    // Holding the account at 100% is the scheduler's call. Folded in here,
    // it reached the cache, both tables and the Usage panel, which then
    // drew a 7-day window resetting with the 5h, days before the Fable
    // window on the same week.
    const weeklyReset = '2099-01-06T15:00:00.000Z'
    await seedAccount('claude-code', true, 'anna', 'tok-anna')
    stubUsage(200, {
      five_hour: { utilization: 100, resets_at: '2099-01-01T05:00:00.000Z' },
      seven_day: { utilization: 80, resets_at: weeklyReset },
      limits: [
        { kind: 'weekly_scoped', percent: 100, resets_at: weeklyReset, scope: { model: { display_name: 'Fable' } } }
      ]
    })

    const { usage } = await fetchUsageSnapshot({ forceRefresh: true })
    expect(usage.claude[0]?.sevenDay).toEqual({ utilization: 80, resetsAt: weeklyReset })
    expect(usage.claude[0]?.weeklyScoped).toEqual([{ modelName: 'Fable', utilization: 100, resetsAt: weeklyReset }])
  })

  test('an account on a disabled provider is never polled, forced or not', async () => {
    await seedAccount('claude-code', true, 'anna', 'tok-anna')
    await seedAccount('claude-off', false, 'carol', 'tok-carol')

    const forced = await fetchUsageSnapshotWithAccountIds({ forceRefresh: true })
    expect(forced.claude.map((c) => c.usage.accountLabel)).toEqual(['Account'])
    expect(tokensCalled).toEqual(['tok-anna'])

    // The scheduled poll reads the same pool, so carol stays out of it
    // too; anna is served from the entry the forced pass just cached.
    const scheduled = await fetchUsageSnapshotWithAccountIds()
    expect(scheduled.claude).toHaveLength(1)
    expect(tokensCalled).toEqual(['tok-anna'])
  })
})
