/**
 * Tests for the codex-auth domain — the JWT claim readers, the
 * freshness decision, the shared refresh lock, and the credential-file
 * shape.
 *
 * The regression that motivates most of this: `SubAccount.expiresAt`
 * used to hold the SUBSCRIPTION end date for Codex rows (months out),
 * while every near-expiry check read it as the ACCESS TOKEN's expiry —
 * so an hour-long token was never rotated. Freshness now comes off the
 * token's own `exp` claim first, which is what
 * "token exp wins over a stored expiresAt months out" pins down.
 *
 * Three halves:
 *  1. Pure (no DB, no network): claims, needs-refresh, lock, schema.
 *  2. Network (stubbed fetch): the rotation round trip.
 *  3. DB (requires HAS_DB): what the rotation persists.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { CodexCredentialsFileSchema } from '../../src/schemas/wire/oauth'
import { codexAccessTokenExpiry, codexIdentityFrom, decodeJwtPayload } from '../../src/services/codex-auth/claims'
import { codexTokenNeedsRefresh, ensureFreshCodexAccessToken } from '../../src/services/codex-auth/token'
import { isRefreshInFlight, withRefreshLock } from '../../src/services/oauth/refresh-lock'
import { HAS_DB, resetDbTables, teardownPrisma } from '../db/helpers'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

// header.payload.signature — nothing verifies the signature, so a
// placeholder third segment is enough.
const makeJwt = (payload: Record<string, unknown>): string =>
  `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.sig`

const secondsFromNow = (seconds: number): number => Math.floor(Date.now() / 1000) + seconds

const makeAccessToken = (expiresInSeconds: number): string => makeJwt({ exp: secondsFromNow(expiresInSeconds) })

const makeIdToken = (overrides: Record<string, unknown> = {}): string =>
  makeJwt({
    sub: 'user-sub-abc',
    name: 'Codex User',
    email: 'codex@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc-xyz',
      chatgpt_plan_type: 'pro',
      chatgpt_subscription_active_until: '2027-01-31T00:00:00Z'
    },
    ...overrides
  })

// ---------------------------------------------------------------------------
// 1. Claims
// ---------------------------------------------------------------------------

describe('codex-auth / claims', () => {
  test('decodeJwtPayload returns the payload object', () => {
    expect(decodeJwtPayload(makeJwt({ hello: 'world' }))).toEqual({ hello: 'world' })
  })

  test('decodeJwtPayload returns null for input that is not a JWT', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull()
    expect(decodeJwtPayload('')).toBeNull()
    expect(decodeJwtPayload(null)).toBeNull()
    // Well-formed shape, undecodable payload.
    expect(decodeJwtPayload('aaa.!!!!.ccc')).toBeNull()
  })

  test('decodeJwtPayload returns null when the payload is not an object', () => {
    expect(decodeJwtPayload(`${b64url({})}.${b64url('a string')}.sig`)).toBeNull()
  })

  test('codexAccessTokenExpiry reads the exp claim', () => {
    const exp = secondsFromNow(3600)
    const expiry = codexAccessTokenExpiry(makeJwt({ exp }))
    expect(expiry).not.toBeNull()
    expect(expiry?.valueOf()).toBe(exp * 1000)
  })

  test('codexAccessTokenExpiry returns null when there is no usable exp', () => {
    expect(codexAccessTokenExpiry(makeJwt({}))).toBeNull()
    expect(codexAccessTokenExpiry(makeJwt({ exp: 'soon' }))).toBeNull()
    expect(codexAccessTokenExpiry('opaque-token')).toBeNull()
    expect(codexAccessTokenExpiry(null)).toBeNull()
  })

  test('codexIdentityFrom pulls identity, plan and subscription end date', () => {
    const identity = codexIdentityFrom(makeIdToken())
    expect(identity).not.toBeNull()
    expect(identity?.accountId).toBe('acc-xyz')
    expect(identity?.userId).toBe('user-sub-abc')
    expect(identity?.userName).toBe('Codex User')
    expect(identity?.userEmail).toBe('codex@example.com')
    expect(identity?.planType).toBe('pro')
    expect(identity?.subscriptionEndsAt?.toISOString()).toBe('2027-01-31T00:00:00.000Z')
  })

  test('codexIdentityFrom tolerates a missing auth claim block', () => {
    const identity = codexIdentityFrom(makeJwt({ sub: 'only-sub' }))
    expect(identity).not.toBeNull()
    expect(identity?.userId).toBe('only-sub')
    expect(identity?.accountId).toBeNull()
    expect(identity?.subscriptionEndsAt).toBeNull()
  })

  test('codexIdentityFrom ignores an unparseable subscription end date', () => {
    const identity = codexIdentityFrom(
      makeIdToken({ 'https://api.openai.com/auth': { chatgpt_subscription_active_until: 'whenever' } })
    )
    expect(identity?.subscriptionEndsAt).toBeNull()
  })

  test('codexIdentityFrom returns null when the token cannot be decoded', () => {
    expect(codexIdentityFrom('garbage')).toBeNull()
    expect(codexIdentityFrom(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. Freshness decision
// ---------------------------------------------------------------------------

describe('codex-auth / codexTokenNeedsRefresh', () => {
  test('false while the token is comfortably ahead of expiry', () => {
    expect(codexTokenNeedsRefresh({ accessToken: makeAccessToken(3600) })).toBe(false)
  })

  test('true inside the 5-minute leeway', () => {
    expect(codexTokenNeedsRefresh({ accessToken: makeAccessToken(60) })).toBe(true)
  })

  test('true once the token has expired', () => {
    expect(codexTokenNeedsRefresh({ accessToken: makeAccessToken(-60) })).toBe(true)
  })

  test('true for an empty access token', () => {
    expect(codexTokenNeedsRefresh({ accessToken: '' })).toBe(true)
  })

  // The regression: rows written before the column split carry a
  // subscription end date in expiresAt. The token's own exp has to win,
  // or those accounts never refresh.
  test('the token exp wins over a stored expiresAt months in the future', () => {
    const subscriptionEnd = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
    expect(
      codexTokenNeedsRefresh({
        accessToken: makeAccessToken(-60),
        expiresAt: subscriptionEnd
      })
    ).toBe(true)
  })

  test('the token exp also wins when the stored column is pessimistic', () => {
    expect(
      codexTokenNeedsRefresh({
        accessToken: makeAccessToken(3600),
        expiresAt: new Date(Date.now() - 1000)
      })
    ).toBe(false)
  })

  test('falls back to the stored expiresAt for a token with no exp claim', () => {
    expect(codexTokenNeedsRefresh({ accessToken: 'opaque', expiresAt: new Date(Date.now() + 60 * 60 * 1000) })).toBe(
      false
    )
    expect(codexTokenNeedsRefresh({ accessToken: 'opaque', expiresAt: new Date(Date.now() + 60 * 1000) })).toBe(true)
  })

  test('falls back to lastSyncedAt when nothing states an expiry', () => {
    expect(codexTokenNeedsRefresh({ accessToken: 'opaque', lastSyncedAt: new Date(Date.now() - 60 * 60 * 1000) })).toBe(
      true
    )
    expect(codexTokenNeedsRefresh({ accessToken: 'opaque', lastSyncedAt: new Date(Date.now() - 60 * 1000) })).toBe(
      false
    )
  })

  test('false when no source states an expiry at all', () => {
    expect(codexTokenNeedsRefresh({ accessToken: 'opaque' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. Shared refresh lock
// ---------------------------------------------------------------------------

describe('oauth / refresh-lock', () => {
  test('concurrent calls for one key run the body exactly once', async () => {
    const key = `lock-${crypto.randomUUID()}`
    let calls = 0
    const body = async (): Promise<string> => {
      calls++
      await Bun.sleep(10)
      return 'rotated'
    }
    const [a, b, c] = await Promise.all([
      withRefreshLock(key, body),
      withRefreshLock(key, body),
      withRefreshLock(key, body)
    ])
    expect(calls).toBe(1)
    expect([a, b, c]).toEqual(['rotated', 'rotated', 'rotated'])
  })

  test('different keys do not block each other', async () => {
    let calls = 0
    const body = async (): Promise<string> => {
      calls++
      return 'ok'
    }
    await Promise.all([
      withRefreshLock(`k1-${crypto.randomUUID()}`, body),
      withRefreshLock(`k2-${crypto.randomUUID()}`, body)
    ])
    expect(calls).toBe(2)
  })

  test('the key is released after the body settles, success or failure', async () => {
    const key = `lock-${crypto.randomUUID()}`
    await expect(
      withRefreshLock(key, async () => {
        throw new Error('upstream 503')
      })
    ).rejects.toThrow('upstream 503')
    expect(isRefreshInFlight(key)).toBe(false)

    const second = await withRefreshLock(key, async () => 'recovered')
    expect(second).toBe('recovered')
  })
})

// ---------------------------------------------------------------------------
// 4. Credential file shape
// ---------------------------------------------------------------------------

describe('CodexCredentialsFileSchema', () => {
  test('accepts an auth.json identified only by account_id', () => {
    const parsed = CodexCredentialsFileSchema.safeParse({
      tokens: { access_token: 'at', refresh_token: 'rt', account_id: 'acc-xyz' }
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.accountId).toBe('acc-xyz')
    expect(parsed.data?.idToken).toBeNull()
  })

  test('accepts an auth.json identified only by id_token', () => {
    const idToken = makeIdToken()
    const parsed = CodexCredentialsFileSchema.safeParse({
      tokens: { access_token: 'at', refresh_token: 'rt', id_token: idToken }
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.idToken).toBe(idToken)
    expect(parsed.data?.accountId).toBeNull()
  })

  test('keeps both when the file carries both', () => {
    const parsed = CodexCredentialsFileSchema.safeParse({
      tokens: { access_token: 'at', refresh_token: 'rt', id_token: makeIdToken(), account_id: 'acc-xyz' }
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.accountId).toBe('acc-xyz')
    expect(parsed.data?.idToken).not.toBeNull()
  })

  test('rejects a file that identifies the account by neither', () => {
    const parsed = CodexCredentialsFileSchema.safeParse({
      tokens: { access_token: 'at', refresh_token: 'rt' }
    })
    expect(parsed.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. Rotation — network stubbed, persistence against the DB
// ---------------------------------------------------------------------------

const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const realFetch = globalThis.fetch

interface TokenEndpointStub {
  calls: number
  lastBody: string
}

// Replace global fetch with a stub that answers the OpenAI token
// endpoint and refuses anything else, so a stray request fails loudly
// instead of reaching the network.
const stubTokenEndpoint = (respond: () => Response): TokenEndpointStub => {
  const stub: TokenEndpointStub = { calls: 0, lastBody: '' }
  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url !== TOKEN_URL) throw new Error(`unexpected fetch to ${url}`)
    stub.calls++
    stub.lastBody = typeof init?.body === 'string' ? init.body : ''
    return respond()
  }
  globalThis.fetch = fake as typeof globalThis.fetch
  return stub
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('codex-auth / ensureFreshCodexAccessToken (no DB write needed)', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('returns the held token untouched when it is still fresh', async () => {
    const stub = stubTokenEndpoint(() => jsonResponse({}))
    const held = makeAccessToken(3600)
    const token = await ensureFreshCodexAccessToken({
      subAccountId: `sa-${crypto.randomUUID()}`,
      accessToken: held,
      refreshToken: 'rt'
    })
    expect(token).toBe(held)
    expect(stub.calls).toBe(0)
  })

  test('returns the held token when there is no refresh token to spend', async () => {
    const stub = stubTokenEndpoint(() => jsonResponse({}))
    const held = makeAccessToken(-60)
    const token = await ensureFreshCodexAccessToken({
      subAccountId: `sa-${crypto.randomUUID()}`,
      accessToken: held,
      refreshToken: null
    })
    expect(token).toBe(held)
    expect(stub.calls).toBe(0)
  })

  test('falls back to the held token when the token endpoint fails', async () => {
    const stub = stubTokenEndpoint(() => jsonResponse({ error: 'server_error' }, 500))
    const held = makeAccessToken(-60)
    const token = await ensureFreshCodexAccessToken({
      subAccountId: `sa-${crypto.randomUUID()}`,
      accessToken: held,
      refreshToken: 'rt'
    })
    expect(token).toBe(held)
    expect(stub.calls).toBe(1)
  })
})

describe.skipIf(!HAS_DB)('codex-auth / ensureFreshCodexAccessToken persistence', () => {
  const TEST_KEY_HEX = 'ab'.repeat(32)

  beforeEach(async () => {
    process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY = TEST_KEY_HEX
    await resetDbTables()
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  afterAll(async () => {
    delete process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY
    await teardownPrisma()
  })

  const seedCodexAccount = async (accessToken: string) => {
    const { getPrismaClient } = await import('../../src/db/client')
    const { AuthMode } = await import('../../src/generated/prisma/client')
    const { buildCodexDiscoveredAccount, recordDiscoveredAccount } = await import(
      '../../src/services/subscription-account-sync-service'
    )
    const db = getPrismaClient()
    await db.provider.create({
      data: {
        name: 'codex-oauth',
        apiBaseUrl: 'https://chatgpt.com/backend-api/codex',
        authMode: AuthMode.subscription
      }
    })
    // Straight to the write path: these tests are about the stored grant,
    // and connecting would first ask the vendor to accept it.
    const account = buildCodexDiscoveredAccount({ accessToken, refreshToken: 'rt-original', idToken: makeIdToken() })
    if (account === null) throw new Error('the test id_token should key an account')
    await recordDiscoveredAccount('codex', account)
    const row = await db.subAccount.findFirstOrThrow()
    return { db, row }
  }

  test('an expired token is rotated and the whole grant is persisted', async () => {
    const { db, row } = await seedCodexAccount(makeAccessToken(-60))
    const rotatedAccess = makeAccessToken(3600)
    const rotatedId = makeIdToken({ name: 'Rotated User' })
    const stub = stubTokenEndpoint(() =>
      jsonResponse({ access_token: rotatedAccess, refresh_token: 'rt-rotated', id_token: rotatedId })
    )

    const token = await ensureFreshCodexAccessToken({
      subAccountId: row.id,
      accessToken: makeAccessToken(-60),
      refreshToken: 'rt-original',
      expiresAt: row.expiresAt
    })

    expect(token).toBe(rotatedAccess)
    expect(stub.calls).toBe(1)
    expect(stub.lastBody).toContain('grant_type=refresh_token')

    const { decryptString } = await import('../../src/services/subscription-account-sync-service')
    const key = Buffer.from(TEST_KEY_HEX, 'hex')
    const after = await db.subAccount.findUniqueOrThrow({ where: { id: row.id } })
    expect(decryptString(after.accessTokenEnc, key)).toBe(rotatedAccess)
    expect(decryptString(after.refreshTokenEnc, key)).toBe('rt-rotated')
    // The rotated id_token has to land too — /export-credentials hands
    // it back for re-import, and it used to stay frozen at OAuth time.
    expect(decryptString(after.idTokenEnc, key)).toBe(rotatedId)
    // expiresAt tracks the NEW token's own exp claim.
    expect(after.expiresAt?.valueOf()).toBe(codexAccessTokenExpiry(rotatedAccess)?.valueOf())
  })

  test('OAuth-time expiresAt is the access token expiry, not the subscription end', async () => {
    const accessToken = makeAccessToken(3600)
    const { row } = await seedCodexAccount(accessToken)
    expect(row.expiresAt?.valueOf()).toBe(codexAccessTokenExpiry(accessToken)?.valueOf())
    expect(row.subscriptionEndsAt?.toISOString()).toBe('2027-01-31T00:00:00.000Z')
  })
})
