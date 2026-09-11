/**
 * POST /api/oauth/import-credentials — an imported file becomes an account
 * only once the vendor accepts it, and arrives live with its windows read.
 *
 *   - a document that is not a credentials file is refused as such (400)
 *   - Codex credentials with no account id are refused before any upstream
 *     call, so they cost neither a request nor a refresh token
 *   - credentials the vendor refuses are refused (400) and nothing is
 *     written, after one refresh attempt when a refresh token came along
 *   - a refused access token that refreshes is accepted, and the rotated
 *     grant is what gets stored
 *   - a vendor that cannot be reached leaves nothing written (502)
 *   - an accepted account is stored `live`, with SubAccountUsage /
 *     SubAccountQuota filled in the same request
 *
 * The first two need no database; the rest are DB-gated.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { oauthRoute } from '../../src/api/oauth/route'
import { getPrismaClient } from '../../src/db/client'
import { AuthMode, AuthStatus } from '../../src/generated/prisma/client'
import { decryptString, encryptionKey } from '../../src/services/subscription-account-sync/crypto'
import { __clearUsageCachesForTest } from '../../src/services/usage-service'
import { HAS_DB, resetDbTables, teardownPrisma } from '../db/helpers'

const TEST_KEY_HEX = 'ab'.repeat(32)

const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
const jwt = (payload: Record<string, unknown>): string =>
  `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.sig`

// Expires next century, so nothing on the usage path decides to rotate it.
const codexAccess = (name: string): string => jwt({ sub: name, exp: 4_102_444_800 })
const codexIdToken = jwt({
  sub: 'user-codex',
  email: 'codex@example.com',
  'https://api.openai.com/auth': { chatgpt_account_id: 'acc-codex', chatgpt_plan_type: 'plus' }
})

const claudeProfileBody = {
  account: { uuid: 'acct-claude', email: 'claude@example.com', full_name: 'Claude User' },
  organization: { uuid: 'org-claude', organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' }
}
const claudeUsageBody = {
  five_hour: { utilization: 42, resets_at: '2099-01-01T05:00:00.000Z' },
  seven_day: { utilization: 12, resets_at: '2099-01-07T00:00:00.000Z' }
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

// Each upstream URL gets its own responder; anything unlisted fails the
// test loudly instead of reaching the network.
const stubUpstream = (routes: Record<string, (call: UpstreamCall) => Response>): void => {
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = { url: urlOf(input), token: bearerOf(init) }
    calls.push(call)
    const respond = routes[call.url]
    if (respond === undefined) throw new Error(`unexpected upstream call: ${call.url}`)
    return respond(call)
  }
  globalThis.fetch = Object.assign(fake, { preconnect: originalFetch.preconnect })
}

const importFile = (provider: string, credentials: unknown): Promise<Response> =>
  oauthRoute.fetch(
    new Request('http://local/api/oauth/import-credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, credentials })
    })
  )

const errorOf = async (res: Response): Promise<string> => {
  const body: { success: boolean; error?: string } = await res.json()
  return body.error === undefined ? '' : body.error
}

describe('POST /api/oauth/import-credentials — refused before any upstream call', () => {
  beforeEach(() => {
    calls.length = 0
    stubUpstream({})
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('a document that is not a credentials file is refused as such', async () => {
    const res = await importFile('codex', { hello: 'world' })
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toContain('Not a Codex credentials file')
    expect(calls).toHaveLength(0)
  })

  test('Codex credentials that name no account are refused without asking the vendor', async () => {
    const res = await importFile('codex', { tokens: { access_token: codexAccess('anon'), refresh_token: 'rt' } })
    expect(res.status).toBe(400)
    // The file's own shape already says it cannot be keyed: it carries
    // neither an id_token nor an account_id, and the schema needs one.
    expect(await errorOf(res)).toContain('tokens.id_token or tokens.account_id')
    expect(calls).toHaveLength(0)
  })
})

describe.skipIf(!HAS_DB)('POST /api/oauth/import-credentials (DB)', () => {
  beforeEach(async () => {
    process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY = TEST_KEY_HEX
    await resetDbTables()
    __clearUsageCachesForTest()
    calls.length = 0
    const prisma = getPrismaClient()
    await prisma.provider.create({
      data: {
        name: 'claude-code',
        apiBaseUrl: 'https://api.anthropic.com/v1/messages',
        authMode: AuthMode.subscription
      }
    })
    await prisma.provider.create({
      data: { name: 'codex', apiBaseUrl: 'https://chatgpt.com/backend-api/codex', authMode: AuthMode.subscription }
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  afterAll(async () => {
    delete process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY
    __clearUsageCachesForTest()
    await teardownPrisma()
  })

  test('Codex credentials the vendor refuses are refused, and nothing is written', async () => {
    stubUpstream({ [CODEX_USAGE_URL]: () => json({ detail: 'Unauthorized' }, 401) })

    const res = await importFile('codex', {
      tokens: { access_token: codexAccess('dead'), refresh_token: '', id_token: codexIdToken }
    })

    expect(res.status).toBe(400)
    expect(await errorOf(res)).toContain('Codex rejected these credentials (HTTP 401)')
    expect(await getPrismaClient().subAccount.count()).toBe(0)
  })

  test('a refused Codex access token is refreshed once, and the rotated grant is stored live with its windows', async () => {
    const rotated = codexAccess('rotated')
    stubUpstream({
      [CODEX_USAGE_URL]: (call) => (call.token === rotated ? json(codexUsageBody) : json({ detail: 'expired' }, 401)),
      [CODEX_TOKEN_URL]: () => json({ access_token: rotated, refresh_token: 'rt-rotated', id_token: codexIdToken })
    })

    const res = await importFile('codex', {
      tokens: { access_token: codexAccess('stale'), refresh_token: 'rt-original', id_token: codexIdToken }
    })

    expect(res.status).toBe(200)
    const prisma = getPrismaClient()
    const row = await prisma.subAccount.findFirstOrThrow()
    expect(row.authStatus).toBe(AuthStatus.live)
    expect(decryptString(row.accessTokenEnc, encryptionKey())).toBe(rotated)
    expect(decryptString(row.refreshTokenEnc, encryptionKey())).toBe('rt-rotated')
    const usage = await prisma.subAccountUsage.findMany({ where: { subAccountId: row.id }, orderBy: { metric: 'asc' } })
    expect(usage.map((u) => [u.metric, u.percent])).toEqual([
      ['codex.primary', 30],
      ['codex.secondary', 80]
    ])
    const quota = await prisma.subAccountQuota.findUniqueOrThrow({ where: { subAccountId: row.id } })
    expect(quota.weeklyUsed).toBe(80)
  })

  test('a Claude account the vendor accepts is stored live, with its windows read in the same request', async () => {
    stubUpstream({
      [CLAUDE_PROFILE_URL]: () => json(claudeProfileBody),
      [CLAUDE_USAGE_URL]: () => json(claudeUsageBody)
    })

    const res = await importFile('claude', {
      claudeAiOauth: { accessToken: 'claude-live', refreshToken: 'rt-claude', expiresAt: 4_102_444_800_000 }
    })

    expect(res.status).toBe(200)
    const prisma = getPrismaClient()
    const row = await prisma.subAccount.findFirstOrThrow()
    expect(row.authStatus).toBe(AuthStatus.live)
    expect(row.userEmail).toBe('claude@example.com')
    const usage = await prisma.subAccountUsage.findMany({ where: { subAccountId: row.id }, orderBy: { metric: 'asc' } })
    expect(usage.map((u) => [u.metric, u.percent])).toEqual([
      ['claude.five_hour', 42],
      ['claude.seven_day', 12]
    ])
  })

  test('Claude credentials still refused after a refresh attempt are refused, and nothing is written', async () => {
    stubUpstream({
      [CLAUDE_PROFILE_URL]: () => json({ error: { message: 'invalid token' } }, 401),
      [CLAUDE_TOKEN_URL]: () => json({ error: 'invalid_grant' }, 400)
    })

    const res = await importFile('claude', { accessToken: 'claude-dead', refreshToken: 'rt-dead' })

    expect(res.status).toBe(400)
    expect(await errorOf(res)).toContain('Claude rejected these credentials (HTTP 401)')
    expect(calls.map((c) => c.url)).toEqual([CLAUDE_PROFILE_URL, CLAUDE_TOKEN_URL])
    expect(await getPrismaClient().subAccount.count()).toBe(0)
  })

  test('a vendor that cannot be reached leaves nothing written', async () => {
    stubUpstream({ [CLAUDE_PROFILE_URL]: () => json({ error: 'overloaded' }, 529) })

    const res = await importFile('claude', { accessToken: 'claude-token', refreshToken: 'rt' })

    expect(res.status).toBe(502)
    expect(await errorOf(res)).toContain('Could not verify these credentials with Claude (HTTP 529)')
    expect(await getPrismaClient().subAccount.count()).toBe(0)
  })
})
