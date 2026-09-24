/**
 * Unit tests for OAuthTransformer — the shared scaffolding behind
 * claude-code-oauth and codex-oauth.
 *
 * Three contracts the base class guarantees:
 *
 *  1. resolveSubscriptionAuth REJECTS unless the DB-synced overlay
 *     carries non-empty subAccountId + accessToken (parsed strictly by
 *     OauthSubscriptionAuthBlockSchema). There is no disk fallback.
 *  2. When expiresAt is in the future (or null), the stored access
 *     token is returned verbatim — no refresh runs.
 *  3. When expiresAt is within the 5-minute leeway, refresh() is
 *     invoked exactly once across concurrent callers (in-flight dedup),
 *     the result is persisted via updateSubAccountAccessToken, and the
 *     fresh access token is returned. Refresh failures fall back to the
 *     existing token instead of throwing.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { HTTPException } from 'hono/http-exception'
import dayjs from '../../../src/lib/dayjs'
import {
  type OAuthRefreshResult,
  OAuthTransformer,
  type OauthCredentials
} from '../../../src/llms/transformers/oauth-base'
import type { RuntimeProvider, TransformerContext } from '../../../src/schemas/domain/pipeline'

// Spy that records every call so tests can assert the refresh writeback
// fired (or didn't).
const updateMock = mock(async () => {})

// Replace the writeback module-side so OAuthTransformer.refreshIfNearExpiry's
// import resolves to our spy. mock.module rewires the module graph for the
// rest of the PROCESS, not just this file — so the factory has to hand back the
// whole barrel. Returning the one spy alone left every later test file that
// imports another export of it failing with
// `SyntaxError: Export named '...' not found`, on whatever file order bun
// picked that run.
const realSyncService = await import('../../../src/services/subscription-account-sync-service')

mock.module('../../../src/services/subscription-account-sync-service', () => ({
  ...realSyncService,
  updateSubAccountAccessToken: updateMock
}))

class TestTransformer extends OAuthTransformer {
  readonly name = 'test-oauth'
  refreshCalls: Array<{ refreshToken: string }> = []
  refreshResult: OAuthRefreshResult | null | Error = null

  protected async refresh(input: { refreshToken: string }): Promise<OAuthRefreshResult | null> {
    this.refreshCalls.push(input)
    if (this.refreshResult instanceof Error) throw this.refreshResult
    return this.refreshResult
  }

  resolveAuth(provider: unknown, context?: TransformerContext): Promise<OauthCredentials> {
    return this.resolveSubscriptionAuth(
      provider as RuntimeProvider | null | undefined,
      undefined,
      undefined,
      undefined,
      context
    )
  }
}

const makeProvider = (subscriptionAuth: Record<string, unknown> | undefined): unknown => ({
  transformer: subscriptionAuth ? { subscriptionAuth } : {}
})

beforeEach(() => {
  updateMock.mockClear()
})

afterEach(() => {
  // Reset the singleton in-flight map by importing nothing — the map
  // self-clears after each test's promise resolves, so this is a no-op
  // but documented as a deliberate "no shared state across tests".
})

describe('OAuthTransformer.resolveSubscriptionAuth — rejection cases', () => {
  test('throws 401 when subscriptionAuth is missing entirely', async () => {
    const t = new TestTransformer()
    await expect(t.resolveAuth(makeProvider(undefined))).rejects.toBeInstanceOf(HTTPException)
  })

  test('throws 401 when subAccountId is missing', async () => {
    const t = new TestTransformer()
    await expect(t.resolveAuth(makeProvider({ accessToken: 'a' }))).rejects.toBeInstanceOf(HTTPException)
  })

  test('throws 401 when accessToken is missing', async () => {
    const t = new TestTransformer()
    await expect(t.resolveAuth(makeProvider({ subAccountId: 'sa' }))).rejects.toBeInstanceOf(HTTPException)
  })

  test('throws 401 when accessToken is an empty string (nonempty constraint)', async () => {
    const t = new TestTransformer()
    await expect(t.resolveAuth(makeProvider({ subAccountId: 'sa', accessToken: '' }))).rejects.toBeInstanceOf(
      HTTPException
    )
  })

  test('throws 401 when provider is null / undefined', async () => {
    const t = new TestTransformer()
    await expect(t.resolveAuth(null)).rejects.toBeInstanceOf(HTTPException)
    await expect(t.resolveAuth(undefined)).rejects.toBeInstanceOf(HTTPException)
  })
})

describe('OAuthTransformer.resolveSubscriptionAuth — happy path (no refresh needed)', () => {
  test('returns the DB token + accountId when expiresAt is far in the future', async () => {
    const t = new TestTransformer()
    const farFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const result = await t.resolveAuth(
      makeProvider({
        subAccountId: 'sa-1',
        accessToken: 'token-A',
        accountId: 'acc-A',
        expiresAt: farFuture
      })
    )
    expect(result).toEqual({ token: 'token-A', accountId: 'acc-A' })
    expect(t.refreshCalls).toEqual([])
    expect(updateMock).not.toHaveBeenCalled()
  })

  test('returns the DB token without accountId when accountId is absent', async () => {
    const t = new TestTransformer()
    const result = await t.resolveAuth(makeProvider({ subAccountId: 'sa-1', accessToken: 'token-A', expiresAt: null }))
    expect(result).toEqual({ token: 'token-A' })
    expect(t.refreshCalls).toEqual([])
  })

  test('skips refresh when expiresAt is null (no upstream expiry information)', async () => {
    const t = new TestTransformer()
    t.refreshResult = { accessToken: 'fresh' }
    const result = await t.resolveAuth(
      makeProvider({ subAccountId: 'sa-1', accessToken: 'stale', refreshToken: 'rt', expiresAt: null })
    )
    expect(result.token).toBe('stale')
    expect(t.refreshCalls).toEqual([])
  })
})

describe('OAuthTransformer.resolveSubscriptionAuth — refresh path', () => {
  const nearExpiry = (): Date => new Date(Date.now() + 60 * 1000) // 1 min — within the 5 min leeway

  test('runs refresh and writes back the new token when expiresAt is within the leeway', async () => {
    const t = new TestTransformer()
    t.refreshResult = {
      accessToken: 'fresh-token',
      refreshToken: 'new-rt',
      expiresAt: new Date(Date.now() + 3600_000)
    }
    const result = await t.resolveAuth(
      makeProvider({
        subAccountId: 'sa-1',
        accessToken: 'stale-token',
        refreshToken: 'old-rt',
        expiresAt: nearExpiry().toISOString()
      })
    )
    expect(result.token).toBe('fresh-token')
    expect(t.refreshCalls).toEqual([{ refreshToken: 'old-rt' }])
    expect(updateMock).toHaveBeenCalledTimes(1)
    expect(updateMock).toHaveBeenCalledWith('sa-1', {
      accessToken: 'fresh-token',
      refreshToken: 'new-rt',
      expiresAt: expect.any(Date)
    })
  })

  test('skips refresh when refreshToken is empty (cannot rotate without it)', async () => {
    const t = new TestTransformer()
    t.refreshResult = { accessToken: 'fresh' }
    const result = await t.resolveAuth(
      makeProvider({ subAccountId: 'sa-1', accessToken: 'stale', expiresAt: nearExpiry() })
    )
    expect(result.token).toBe('stale')
    expect(t.refreshCalls).toEqual([])
  })

  test('falls back to the existing token when refresh() throws', async () => {
    const t = new TestTransformer()
    t.refreshResult = new Error('upstream 503')
    const result = await t.resolveAuth(
      makeProvider({
        subAccountId: 'sa-1',
        accessToken: 'stale',
        refreshToken: 'rt',
        expiresAt: nearExpiry()
      })
    )
    expect(result.token).toBe('stale')
    expect(t.refreshCalls).toHaveLength(1)
    expect(updateMock).not.toHaveBeenCalled()
  })

  test('falls back to existing token when refresh() returns null (no-op refresh)', async () => {
    const t = new TestTransformer()
    t.refreshResult = null
    const result = await t.resolveAuth(
      makeProvider({
        subAccountId: 'sa-1',
        accessToken: 'stale',
        refreshToken: 'rt',
        expiresAt: nearExpiry()
      })
    )
    expect(result.token).toBe('stale')
    expect(updateMock).not.toHaveBeenCalled()
  })

  test('concurrent callers share one in-flight refresh per subAccountId', async () => {
    const t = new TestTransformer()
    let resolveRefresh: ((value: OAuthRefreshResult) => void) | null = null
    const refreshPromise = new Promise<OAuthRefreshResult>((res) => {
      resolveRefresh = res
    })
    // Replace refresh() with one that suspends until we resolve the promise,
    // so we can issue two concurrent calls that observe the same in-flight.
    t.refresh = async (input) => {
      t.refreshCalls.push(input)
      return refreshPromise
    }

    const provider = makeProvider({
      subAccountId: 'sa-1',
      accessToken: 'stale',
      refreshToken: 'rt',
      expiresAt: nearExpiry()
    })

    const p1 = t.resolveAuth(provider)
    const p2 = t.resolveAuth(provider)

    resolveRefresh?.({
      accessToken: 'shared-fresh',
      expiresAt: new Date(Date.now() + 3600_000)
    })

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.token).toBe('shared-fresh')
    expect(r2.token).toBe('shared-fresh')
    expect(t.refreshCalls).toHaveLength(1) // dedup'd
    expect(updateMock).toHaveBeenCalledTimes(1)
  })
})

/**
 * The attempt learns which account it runs on. `context.req` is the
 * request the usage capture reads after the upstream call and the 429
 * path reads to know which account to rotate away from, so the account
 * is stamped there on every way of resolving one.
 */
describe('OAuthTransformer.resolveSubscriptionAuth — stamps the serving account', () => {
  const farFuture = () => dayjs().add(1, 'hour').toISOString()

  test('the resolved account lands on context.req', async () => {
    const t = new TestTransformer()
    const context: TransformerContext = { req: { headers: {}, body: {}, url: '/v1/messages', isSubagent: false } }
    await t.resolveAuth(makeProvider({ subAccountId: 'sa-9', accessToken: 'token-9', expiresAt: farFuture() }), context)
    expect(context.req?.subAccountId).toBe('sa-9')
  })

  test('a probe context without a request is left as it is', async () => {
    const t = new TestTransformer()
    const context: TransformerContext = {}
    await t.resolveAuth(makeProvider({ subAccountId: 'sa-9', accessToken: 'token-9', expiresAt: farFuture() }), context)
    expect(context).toEqual({})
  })

  test('nothing is stamped when no account resolves', async () => {
    const t = new TestTransformer()
    const context: TransformerContext = { req: { headers: {}, body: {}, url: '/v1/messages', isSubagent: false } }
    await expect(t.resolveAuth(makeProvider(undefined), context)).rejects.toBeInstanceOf(HTTPException)
    expect(context.req?.subAccountId).toBeUndefined()
  })
})
