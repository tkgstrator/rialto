/**
 * Banked Codex rate-limit resets, against the test database with the
 * vendor stubbed.
 *
 * The credit list is replayed from a live response
 * (`__tests__/fixtures/codex/rate-limit-reset-credits.json`, ids redacted).
 * Pinned:
 *   - spendable credits are the available, plan-supported ones, soonest
 *     to lapse first — so a spend never lets an earlier credit expire;
 *   - a spend sends that credit with an idempotency key, then re-polls
 *     the account so routing sees the reset before the call returns;
 *   - a Claude account, an unknown id, a refusal and an unreachable
 *     vendor each answer with the status the route turns into a response.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { subscriptionsRoute } from '../../src/api/subscriptions/route'
import { getPrismaClient } from '../../src/db/client'
import { AuthMode } from '../../src/generated/prisma/client'
import dayjs from '../../src/lib/dayjs'
import { CodexResetCreditsWireSchema } from '../../src/schemas/wire/usage'
import {
  listResetCredits,
  ResetCreditError,
  spendableCredits,
  spendResetCredit
} from '../../src/services/codex-reset-service'
import { encryptionKey, encryptString } from '../../src/services/subscription-account-sync/crypto'
import { __clearUsageCachesForTest } from '../../src/services/usage-service'
import { HAS_DB, resetDbTables, teardownPrisma } from '../db/helpers'
import creditsFixture from '../fixtures/codex/rate-limit-reset-credits.json'

const TEST_KEY_HEX = 'ab'.repeat(32)
const CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
const CONSUME_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume'
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
// A JWT that expires next century keeps the token refresh path out.
const codexToken = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ sub: 'x', exp: 4_102_444_800 })}.sig`

const usageAfterReset = {
  plan_type: 'pro',
  rate_limit: {
    primary_window: { used_percent: 0, reset_at: 4_102_462_800, limit_window_seconds: 18_000 },
    secondary_window: { used_percent: 0, reset_at: 4_103_049_600, limit_window_seconds: 604_800 }
  },
  rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const originalFetch = globalThis.fetch
const calls: Array<{ url: string; method: string; body: unknown; accountHeader: string | null }> = []

// One answer per endpoint; a test swaps the consume answer to exercise a
// refusal. Anything else fails the test instead of reaching the network.
const stub = (consume: () => Response | Promise<Response>): void => {
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    calls.push({
      url,
      method: init?.method === undefined ? 'GET' : init.method,
      body,
      accountHeader: new Headers(init?.headers).get('chatgpt-account-id')
    })
    if (url === CREDITS_URL) return json(creditsFixture)
    if (url === CONSUME_URL) return consume()
    if (url === USAGE_URL) return json(usageAfterReset)
    throw new Error(`unexpected upstream call: ${url}`)
  }
  globalThis.fetch = Object.assign(fake, { preconnect: originalFetch.preconnect })
}

describe('spendableCredits', () => {
  test('available, plan-supported credits, soonest to lapse first', () => {
    const parsed = CodexResetCreditsWireSchema.safeParse({
      ...creditsFixture,
      credits: [
        ...creditsFixture.credits,
        { id: 'spent', status: 'redeemed', expires_at: '2026-09-30T00:00:00Z' },
        { id: 'unsupported', status: 'available', is_supported_by_plan: false, expires_at: '2026-09-29T00:00:00Z' }
      ]
    })
    if (!parsed.success) throw new Error(parsed.error.message)
    expect(spendableCredits(parsed.data).map((c) => c.id)).toEqual([
      'RateLimitResetCredit_000000000000000000000000000000a1',
      'RateLimitResetCredit_000000000000000000000000000000a3',
      'RateLimitResetCredit_000000000000000000000000000000a2'
    ])
  })
})

describe.skipIf(!HAS_DB)('codex-reset-service', () => {
  const seed = async () => {
    const prisma = getPrismaClient()
    const key = encryptionKey()
    const codex = await prisma.provider.create({
      data: { name: 'codex', apiBaseUrl: 'https://chatgpt.com/backend-api/codex', authMode: AuthMode.subscription }
    })
    const claude = await prisma.provider.create({
      data: { name: 'claude-code', apiBaseUrl: 'https://api.anthropic.com', authMode: AuthMode.subscription }
    })
    const account = (providerId: string, label: string, token: string, accountId: string | null) =>
      prisma.subAccount.create({
        data: {
          providerId,
          sourcePath: `oauth:test:${label}`,
          label,
          accountId,
          accessTokenEnc: encryptString(token, key),
          refreshTokenEnc: encryptString(`rt-${label}`, key),
          expiresAt: dayjs('2099-01-01T00:00:00Z').toDate()
        }
      })
    return {
      bob: await account(codex.id, 'bob', codexToken, 'chatgpt-acct-bob'),
      anna: await account(claude.id, 'anna', 'tok-anna', null)
    }
  }

  beforeEach(async () => {
    process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY = TEST_KEY_HEX
    await resetDbTables()
    __clearUsageCachesForTest()
    calls.length = 0
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  afterAll(async () => {
    delete process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY
    await teardownPrisma()
  })

  test('lists the spendable credits, read live, with the account header wham expects', async () => {
    const { bob } = await seed()
    stub(() => json({}))
    const view = await listResetCredits(bob.id)
    expect(view.credits.map((c) => c.id)[0]).toBe('RateLimitResetCredit_000000000000000000000000000000a1')
    expect(view.credits).toHaveLength(3)
    // Not polled yet, so how many apply is unknown rather than zero.
    expect(view.applicable).toBeNull()
    expect(calls[0].accountHeader).toBe('chatgpt-acct-bob')
  })

  test('spends the credit closest to lapsing, then re-polls so routing sees the reset', async () => {
    const { bob } = await seed()
    stub(() => json({ result: 'reset' }))
    const result = await spendResetCredit(bob.id)
    expect(result).toEqual({
      spentCreditId: 'RateLimitResetCredit_000000000000000000000000000000a1',
      remaining: 2,
      refreshed: true
    })
    const consume = calls.find((c) => c.url === CONSUME_URL)
    expect(consume?.method).toBe('POST')
    expect(consume?.body).toMatchObject({ credit_id: 'RateLimitResetCredit_000000000000000000000000000000a1' })
    // The idempotency key is a fresh UUID per spend.
    expect(JSON.stringify(consume?.body)).toMatch(/"redeem_request_id":"[0-9a-f-]{36}"/)
    // The follow-up poll landed: the quota row now says what the vendor
    // reported after the reset.
    const quota = await getPrismaClient().subAccountQuota.findUnique({ where: { subAccountId: bob.id } })
    expect(quota).toMatchObject({ fiveHourUsed: 0, resetCreditsAvailable: 2, resetCreditsApplicable: 0 })
  })

  test('a refusal by the vendor is a 409 in its own words, and nothing is re-polled', async () => {
    const { bob } = await seed()
    stub(() => json({ detail: 'No rate limit to reset' }, 400))
    const error = await spendResetCredit(bob.id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ResetCreditError)
    expect(error).toMatchObject({ status: 409, message: 'No rate limit to reset' })
    expect(calls.some((c) => c.url === USAGE_URL)).toBe(false)
  })

  test('a vendor that fails is a 502', async () => {
    const { bob } = await seed()
    stub(() => json({ error: { message: 'upstream down' } }, 503))
    await expect(spendResetCredit(bob.id)).rejects.toMatchObject({ status: 502, message: 'upstream down' })
  })

  test('a Claude account is refused before anything is sent', async () => {
    const { anna } = await seed()
    stub(() => json({}))
    await expect(listResetCredits(anna.id)).rejects.toMatchObject({ status: 409 })
    expect(calls).toEqual([])
  })

  test('the routes answer with the service status', async () => {
    const { anna } = await seed()
    stub(() => json({}))
    const unknown = await subscriptionsRoute.fetch(
      new Request('http://local/api/subscriptions/accounts/nope/reset-credits')
    )
    expect(unknown.status).toBe(404)
    const claude = await subscriptionsRoute.fetch(
      new Request(`http://local/api/subscriptions/accounts/${anna.id}/reset-usage`, { method: 'POST' })
    )
    expect(claude.status).toBe(409)
    expect(await claude.json()).toMatchObject({ error: expect.stringContaining('Codex') })
  })
})
