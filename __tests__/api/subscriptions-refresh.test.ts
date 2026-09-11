/**
 * POST /api/subscriptions/refresh — the account half of the Providers
 * screens' Refresh, end to end against the test database with upstream
 * stubbed.
 *
 *   - profiles are re-synced and usage is polled past the 5-minute cache;
 *     the result lands in SubAccountQuota and SubAccountUsage (what the
 *     list and the account picker read) and NOT in UsageSnapshot (the
 *     Usage chart's 5-minute history)
 *   - accounts on a disabled provider are neither called nor written
 *   - `{ provider }` narrows the refresh to that provider's accounts —
 *     including while the provider is switched off — and calls nothing
 *     else; a name no subscription provider has is a 404
 *   - an account whose upstream call failed is named in `failed[]` and
 *     its rows are left alone, even when a stale cached value exists
 *   - concurrent calls for the same scope share one upstream pass
 *   - POST /api/subscriptions/sync keeps its { updated, failed,
 *     subscriptions } contract and still covers disabled providers
 *
 * DB-gated: skipped when TEST_DATABASE_URL isn't wired up in the env.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { subscriptionsRoute } from '../../src/api/subscriptions/route'
import { getPrismaClient } from '../../src/db/client'
import { AuthMode, AuthStatus } from '../../src/generated/prisma/client'
import dayjs from '../../src/lib/dayjs'
import {
  type SubscriptionRefreshResponse,
  SubscriptionRefreshResponseSchema
} from '../../src/schemas/api/subscriptions'
import { encryptionKey, encryptString } from '../../src/services/subscription-account-sync/crypto'
import { refreshProviderSubscriptions, refreshSubscriptions } from '../../src/services/subscription-refresh-service'
import {
  __clearUsageCachesForTest,
  __seedClaudeCacheForTest,
  __seedCodexCacheForTest,
  type ClaudeUsage,
  type CodexUsage
} from '../../src/services/usage-service'
import { HAS_DB, resetDbTables, teardownPrisma } from '../db/helpers'

const TEST_KEY_HEX = 'ab'.repeat(32)
const FAR_FUTURE = dayjs('2099-01-01T00:00:00.000Z').toDate()

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

// A Codex access token is a JWT whose `exp` claim decides whether the
// shared refresh path rotates it before use. One that expires next
// century keeps the token endpoint out of these tests.
const codexToken = (name: string): string =>
  `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ sub: name, exp: 4_102_444_800 })}.sig`

const claudeUsageBody = {
  five_hour: { utilization: 42, resets_at: '2099-01-01T05:00:00.000Z' },
  seven_day: { utilization: 12, resets_at: '2099-01-07T00:00:00.000Z' }
}
const claudeProfileBody = {
  account: { uuid: 'acct-anna', email: 'anna@example.com', full_name: 'Anna' },
  organization: { uuid: 'org-anna', organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' }
}
const codexUsageBody = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 30, reset_at: 4_102_462_800, limit_window_seconds: 18_000 },
    secondary_window: { used_percent: 80, reset_at: 4_103_049_600, limit_window_seconds: 604_800 }
  }
}

interface UpstreamCall {
  url: string
  token: string
}
const calls: UpstreamCall[] = []
const originalFetch = globalThis.fetch

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

const bearerOf = (init?: RequestInit): string => {
  const auth = new Headers(init?.headers).get('authorization')
  return auth === null ? '' : auth.replace(/^Bearer /, '')
}

// Anything but the three upstream endpoints is refused loudly, so a stray
// request (a token refresh, say) fails the test instead of reaching the
// network.
const answer = (url: string): Response => {
  if (url === CLAUDE_USAGE_URL) return json(claudeUsageBody)
  if (url === CLAUDE_PROFILE_URL) return json(claudeProfileBody)
  if (url === CODEX_USAGE_URL) return json(codexUsageBody)
  throw new Error(`unexpected upstream call: ${url}`)
}

// Record who asked, and let a test fail one endpoint for one token.
const stubUpstream = (failing: UpstreamCall | null = null, delayMs = 0): void => {
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = { url: urlOf(input), token: bearerOf(init) }
    calls.push(call)
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    if (failing !== null && failing.url === call.url && failing.token === call.token)
      return json({ error: 'boom' }, 500)
    return answer(call.url)
  }
  // Bun's fetch carries `preconnect`; keep it so the global keeps its shape.
  globalThis.fetch = Object.assign(fake, { preconnect: originalFetch.preconnect })
}

// No body unless one is given: the bare POST is the shape every caller
// used before the endpoint took one, and it has to keep meaning the same.
const post = (path: string, body?: unknown): Promise<Response> =>
  subscriptionsRoute.fetch(
    new Request(
      `http://local${path}`,
      body === undefined
        ? { method: 'POST' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    )
  )

// Validated against the OpenAPI schema before it is compared, so a shape
// drift fails here by name rather than as a mismatched toEqual.
const refreshBody = async (res: Response): Promise<SubscriptionRefreshResponse> => {
  const parsed = SubscriptionRefreshResponseSchema.safeParse(await res.json())
  if (!parsed.success)
    throw new Error(`response did not match SubscriptionRefreshResponseSchema: ${parsed.error.message}`)
  return parsed.data
}

const seedProvider = (name: string, apiBaseUrl: string, enabled: boolean) =>
  getPrismaClient().provider.create({ data: { name, apiBaseUrl, authMode: AuthMode.subscription, enabled } })

const seedAccount = (providerId: string, label: string, accessToken: string) => {
  const key = encryptionKey()
  return getPrismaClient().subAccount.create({
    data: {
      providerId,
      sourcePath: `oauth:test:${label}`,
      label,
      accessTokenEnc: encryptString(accessToken, key),
      refreshTokenEnc: encryptString(`rt-${label}`, key),
      expiresAt: FAR_FUTURE
    }
  })
}

// Two enabled providers with an account each, and a disabled one whose
// account must come out of a refresh untouched.
const seedInstall = async () => {
  const claude = await seedProvider('claude-code', 'https://api.anthropic.com', true)
  const codex = await seedProvider('codex', 'https://chatgpt.com/backend-api/codex', true)
  const off = await seedProvider('claude-off', 'https://api.anthropic.com', false)
  const anna = await seedAccount(claude.id, 'anna', 'tok-anna')
  const bob = await seedAccount(codex.id, 'bob', codexToken('bob'))
  const carol = await seedAccount(off.id, 'carol', 'tok-carol')
  return { anna, bob, carol }
}

const staleClaude = (subAccountId: string): ClaudeUsage => ({
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

const staleCodex = (subAccountId: string): CodexUsage => ({
  subAccountId,
  accountLabel: 'bob',
  planType: null,
  primary: { usedPercent: 5, resetAt: null, windowSeconds: null },
  secondary: null,
  capturedAt: '2000-01-01T00:00:00.000Z'
})

describe.skipIf(!HAS_DB)('POST /api/subscriptions/refresh', () => {
  beforeEach(async () => {
    process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY = TEST_KEY_HEX
    await resetDbTables()
    __clearUsageCachesForTest()
    calls.length = 0
    stubUpstream()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  afterAll(async () => {
    delete process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY
    __clearUsageCachesForTest()
    await teardownPrisma()
  })

  test('nothing to refresh answers with zero counts and no upstream call', async () => {
    const res = await post('/api/subscriptions/refresh')
    expect(res.status).toBe(200)
    expect(await refreshBody(res)).toEqual({
      attempted: 0,
      refreshed: 0,
      failed: []
    })
    expect(calls).toEqual([])
  })

  test('re-syncs profiles, polls usage past a fresh cache, and rewrites only the current-state tables', async () => {
    const { anna, bob, carol } = await seedInstall()
    // A cache entry the ordinary path would serve as-is: fresh, and wrong.
    __seedClaudeCacheForTest(anna.id, staleClaude(anna.id), dayjs().valueOf())

    const res = await post('/api/subscriptions/refresh')
    expect(res.status).toBe(200)
    expect(await refreshBody(res)).toEqual({
      attempted: 2,
      refreshed: 2,
      failed: []
    })

    const prisma = getPrismaClient()
    const quotas = await prisma.subAccountQuota.findMany()
    expect(quotas.map((q) => q.subAccountId).sort()).toEqual([anna.id, bob.id].sort())
    // 42 came from upstream on this click; 5 is what the cache held.
    expect(quotas.find((q) => q.subAccountId === anna.id)?.fiveHourUsed).toBe(42)
    expect(quotas.find((q) => q.subAccountId === bob.id)?.weeklyUsed).toBe(80)
    const usageRows = await prisma.subAccountUsage.findMany({ where: { subAccountId: anna.id } })
    expect(usageRows.map((r) => r.metric).sort()).toEqual(['claude.five_hour', 'claude.seven_day'])
    // The chart's history is the poller's, on its 5-minute grid.
    expect(await prisma.usageSnapshot.count()).toBe(0)

    const annaRow = await prisma.subAccount.findUniqueOrThrow({ where: { id: anna.id } })
    expect(annaRow.authStatus).toBe(AuthStatus.live)
    expect(annaRow.authCheckedAt).not.toBeNull()

    // Carol's provider is off: no call went out with her token and her
    // row was never probed.
    const carolRow = await prisma.subAccount.findUniqueOrThrow({ where: { id: carol.id } })
    expect(carolRow.authCheckedAt).toBeNull()
    expect(calls.map((c) => c.token)).not.toContain('tok-carol')
    expect(calls.filter((c) => c.url === CLAUDE_USAGE_URL && c.token === 'tok-anna')).toHaveLength(1)
  })

  test('a body with no provider is the same refresh as no body', async () => {
    // The Subscriptions list sends `{}`.
    await seedInstall()
    const res = await post('/api/subscriptions/refresh', {})
    expect(res.status).toBe(200)
    expect(await refreshBody(res)).toEqual({ attempted: 2, refreshed: 2, failed: [] })
    expect(calls.map((c) => c.token)).not.toContain('tok-carol')
  })

  test('a provider-scoped refresh covers that provider while it is switched off, and nothing else', async () => {
    const { anna, bob, carol } = await seedInstall()

    const res = await post('/api/subscriptions/refresh', { provider: 'claude-off' })
    expect(res.status).toBe(200)
    expect(await refreshBody(res)).toEqual({ attempted: 1, refreshed: 1, failed: [] })

    const prisma = getPrismaClient()
    const quotas = await prisma.subAccountQuota.findMany()
    expect(quotas.map((q) => q.subAccountId)).toEqual([carol.id])
    expect(quotas[0]?.fiveHourUsed).toBe(42)
    expect(await prisma.subAccountUsage.count({ where: { subAccountId: carol.id } })).toBe(2)
    const carolRow = await prisma.subAccount.findUniqueOrThrow({ where: { id: carol.id } })
    expect(carolRow.authStatus).toBe(AuthStatus.live)

    // Both of carol's calls went out — profile, then usage — and no other
    // token did: the enabled providers were neither probed nor polled.
    expect(calls.filter((c) => c.token === 'tok-carol').map((c) => c.url)).toEqual([
      CLAUDE_PROFILE_URL,
      CLAUDE_USAGE_URL
    ])
    expect(calls.filter((c) => c.token !== 'tok-carol')).toEqual([])
    const annaRow = await prisma.subAccount.findUniqueOrThrow({ where: { id: anna.id } })
    expect(annaRow.authCheckedAt).toBeNull()
    expect(await prisma.subAccountQuota.findUnique({ where: { subAccountId: bob.id } })).toBeNull()
  })

  test('a name no subscription provider has is a 404 that calls nothing', async () => {
    await seedInstall()
    // An api_key provider has no accounts to refresh, so its name is as
    // unknown here as a typo — and "0 accounts" for either would read as
    // a healthy result.
    await getPrismaClient().provider.create({
      data: { name: 'openai', apiBaseUrl: 'https://api.openai.com/v1', authMode: AuthMode.api_key, enabled: true }
    })

    for (const provider of ['no-such-provider', 'openai']) {
      const res = await post('/api/subscriptions/refresh', { provider })
      expect(res.status).toBe(404)
    }
    expect(calls).toEqual([])
    expect(await getPrismaClient().subAccountQuota.count()).toBe(0)
  })

  test('a failed upstream call names the account and leaves its rows alone', async () => {
    const { anna, bob } = await seedInstall()
    // Bob has a stale reading in the cache. The poller would re-write it
    // under a fresh timestamp; a refresh that just reported him failed
    // must not.
    __seedCodexCacheForTest(bob.id, staleCodex(bob.id), 0)
    stubUpstream({ url: CODEX_USAGE_URL, token: codexToken('bob') })

    const res = await post('/api/subscriptions/refresh')
    expect(res.status).toBe(200)
    expect(await refreshBody(res)).toEqual({
      attempted: 2,
      refreshed: 1,
      failed: [{ subAccountId: bob.id, label: 'bob', providerName: 'codex' }]
    })

    const prisma = getPrismaClient()
    expect(await prisma.subAccountQuota.findUnique({ where: { subAccountId: bob.id } })).toBeNull()
    expect(await prisma.subAccountUsage.count({ where: { subAccountId: bob.id } })).toBe(0)
    expect(await prisma.subAccountQuota.findUnique({ where: { subAccountId: anna.id } })).not.toBeNull()
  })

  test('concurrent refreshes share one upstream pass', async () => {
    await seedInstall()
    stubUpstream(null, 20)

    const [first, second] = await Promise.all([refreshSubscriptions(), refreshSubscriptions()])
    expect(first).toEqual(second)
    expect(first.refreshed).toBe(2)
    expect(calls.filter((c) => c.url === CLAUDE_USAGE_URL && c.token === 'tok-anna')).toHaveLength(1)
    expect(calls.filter((c) => c.url === CODEX_USAGE_URL && c.token === codexToken('bob'))).toHaveLength(2)

    // The lock is released: a later click runs again.
    await refreshSubscriptions()
    expect(calls.filter((c) => c.url === CLAUDE_USAGE_URL && c.token === 'tok-anna')).toHaveLength(2)
  })

  test('concurrent refreshes of one provider share one upstream pass', async () => {
    await seedInstall()
    stubUpstream(null, 20)

    const [first, second] = await Promise.all([
      refreshProviderSubscriptions('claude-code'),
      refreshProviderSubscriptions('claude-code')
    ])
    expect(first).toEqual(second)
    expect(first?.refreshed).toBe(1)
    expect(calls.filter((c) => c.url === CLAUDE_USAGE_URL && c.token === 'tok-anna')).toHaveLength(1)
  })

  test('POST /api/subscriptions/sync keeps its contract and still covers disabled providers', async () => {
    await seedInstall()
    const res = await post('/api/subscriptions/sync')
    expect(res.status).toBe(200)
    // Exactly these three keys, and all three accounts synced — carol's
    // provider being off is a routing fact, not an auth-health one.
    expect(await res.json()).toEqual({ updated: 3, failed: 0, subscriptions: expect.any(Array) })
  })
})
