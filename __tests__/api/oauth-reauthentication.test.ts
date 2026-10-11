import { expect, test } from 'bun:test'
import { oauthRoute } from '../../src/api/oauth/route'
import { generateState, storePendingFlow } from '../../src/services/oauth-flow-service'

test('reports the exact OAuth flow as pending, independently of account health checks', async () => {
  const state = generateState()
  storePendingFlow(state, {
    provider: 'claude',
    codeVerifier: 'verifier',
    redirectUri: 'http://localhost/callback',
    createdAt: Date.now(),
    targetAccountId: 'target'
  })
  const response = await oauthRoute.fetch(new Request(`http://localhost/api/oauth/status/${state}`))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: 'pending' })
})

test('unknown flows are expired instead of reporting authentication success', async () => {
  const response = await oauthRoute.fetch(new Request('http://localhost/api/oauth/status/unknown'))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: 'expired' })
})

test('a pasted callback from another OAuth attempt is rejected before its grant is exchanged', async () => {
  const state = generateState()
  storePendingFlow(state, {
    provider: 'claude',
    codeVerifier: 'verifier',
    redirectUri: 'http://localhost/callback',
    createdAt: Date.now(),
    targetAccountId: 'other'
  })
  const response = await oauthRoute.fetch(
    new Request('http://localhost/api/oauth/manual-callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `code#${state}`, expectedState: 'selected-flow' })
    })
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ success: false })
  const pending = await oauthRoute.fetch(new Request(`http://localhost/api/oauth/status/${state}`))
  expect(await pending.json()).toEqual({ status: 'pending' })
})

test('upstream consent refusal stops the matching flow and exposes its error', async () => {
  const state = generateState()
  storePendingFlow(state, {
    provider: 'claude',
    codeVerifier: 'verifier',
    redirectUri: 'http://localhost/callback',
    createdAt: Date.now()
  })
  await oauthRoute.fetch(new Request(`http://localhost/callback?state=${state}&error=access_denied`))
  const response = await oauthRoute.fetch(new Request(`http://localhost/api/oauth/status/${state}`))
  expect(await response.json()).toMatchObject({ status: 'error' })
})

// These cases exercise the complete routes, vendor verification and actual storage.
import { afterAll, afterEach, beforeEach, describe } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import { AuthMode, AuthStatus } from '../../src/generated/prisma/client'
import { decryptString, encryptionKey } from '../../src/services/subscription-account-sync/crypto'
import { __clearUsageCachesForTest } from '../../src/services/usage-service'
import { HAS_DB, resetDbTables, teardownPrisma } from '../db/helpers'

const originalFetch = globalThis.fetch
const originalKey = process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY
const upstream = { identity: 'selected' }
const jwt = (payload: unknown) => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`
const grant = () => ({
  access_token: jwt({ exp: 4102444800 }),
  refresh_token: 'fresh-refresh',
  expires_in: 3600,
  id_token: jwt({ sub: upstream.identity, 'https://api.openai.com/auth': { chatgpt_account_id: upstream.identity } })
})
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const post = (path: string, body: unknown) =>
  oauthRoute.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  )

describe.skipIf(!HAS_DB)('reauthentication routes (DB)', () => {
  beforeEach(async () => {
    await resetDbTables()
    __clearUsageCachesForTest()
    upstream.identity = 'selected'
    process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY = 'ab'.repeat(32)
    const prisma = getPrismaClient()
    for (const kind of ['claude', 'codex']) {
      const provider = await prisma.provider.create({
        data: {
          name: kind,
          enabled: false,
          authMode: AuthMode.subscription,
          apiBaseUrl: kind === 'claude' ? 'https://api.anthropic.com' : 'https://chatgpt.com/backend-api'
        }
      })
      await prisma.subAccount.create({
        data: {
          id: `${kind}-target`,
          providerId: provider.id,
          label: 'Keep my label',
          sourcePath: 'legacy-path',
          enabled: false,
          userId: 'selected',
          accountId: kind === 'codex' ? 'selected' : null,
          authStatus: AuthStatus.invalid
        }
      })
    }
    globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.endsWith('/oauth/token')) return json(grant())
      if (url.endsWith('/api/oauth/profile'))
        return json({ account: { uuid: upstream.identity, email: 'selected@example.com' } })
      if (url.endsWith('/deviceauth/usercode'))
        return json({ device_auth_id: 'device', user_code: 'CODE-123', interval: '1' })
      if (url.endsWith('/deviceauth/token'))
        return json({ authorization_code: 'code', code_verifier: 'verifier', code_challenge: 'challenge' })
      if (url.endsWith('/wham/usage'))
        return json({
          plan_type: 'plus',
          rate_limit: { primary_window: { used_percent: 0, reset_at: 4102444800, limit_window_seconds: 18000 } }
        })
      if (url.endsWith('/api/oauth/usage'))
        return json({ five_hour: { utilization: 0, resets_at: '2099-01-01T00:00:00Z' } })
      return json({ models: [] })
    }
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })
  afterAll(async () => {
    if (originalKey === undefined) delete process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY
    else process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY = originalKey
    __clearUsageCachesForTest()
    await teardownPrisma()
  })

  async function assertUpdated(kind: string) {
    const prisma = getPrismaClient()
    const row = await prisma.subAccount.findUniqueOrThrow({ where: { id: `${kind}-target` } })
    expect(row.authStatus).toBe(AuthStatus.live)
    expect(row.enabled).toBe(false)
    expect(row.label).toBe('Keep my label')
    expect(row.sourcePath).toBe('legacy-path')
    expect(decryptString(row.refreshTokenEnc, encryptionKey())).toBe('fresh-refresh')
    expect(await prisma.subAccount.count()).toBe(2)
    expect((await prisma.provider.findUniqueOrThrow({ where: { id: row.providerId } })).enabled).toBe(false)
  }

  for (const kind of ['claude', 'codex']) {
    test(`${kind} credential import updates the selected account without recreating it`, async () => {
      const tokens = grant()
      const credentials =
        kind === 'claude'
          ? {
              claudeAiOauth: {
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                expiresAt: 4102444800000
              }
            }
          : { tokens }
      const response = await post('/api/oauth/import-credentials', {
        provider: kind,
        credentials,
        targetAccountId: `${kind}-target`
      })
      expect(response.status).toBe(200)
      await assertUpdated(kind)
    })

    test(`${kind} callback rejects a different identity and reports the failure`, async () => {
      upstream.identity = 'other'
      const state = generateState()
      storePendingFlow(state, {
        provider: kind,
        codeVerifier: 'verifier',
        redirectUri: 'http://localhost/callback',
        createdAt: Date.now(),
        targetAccountId: `${kind}-target`
      })
      const response = await post('/api/oauth/manual-callback', { url: `code#${state}`, expectedState: state })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ success: false })
      const status = await oauthRoute.fetch(new Request(`http://localhost/api/oauth/status/${state}`))
      expect(await status.json()).toMatchObject({ status: 'error' })
      const prisma = getPrismaClient()
      expect(await prisma.subAccount.count()).toBe(2)
      expect((await prisma.subAccount.findUniqueOrThrow({ where: { id: `${kind}-target` } })).accessTokenEnc).toBeNull()
    })
  }

  test('Claude browser callback updates the target and completes its exact flow', async () => {
    const initiated = await post('/api/oauth/initiate/claude', { targetAccountId: 'claude-target' })
    expect(initiated.status).toBe(200)
    const { state } = await initiated.json()
    const callback = await oauthRoute.fetch(new Request(`http://localhost/callback?code=code&state=${state}`))
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toContain('status=ok')
    await assertUpdated('claude')
    const status = await oauthRoute.fetch(new Request(`http://localhost/api/oauth/status/${state}`))
    expect(await status.json()).toEqual({ status: 'connected' })
  })

  test('Codex device authorization retains the selected target through polling', async () => {
    const started = await post('/api/oauth/device/start', { targetAccountId: 'codex-target' })
    expect(started.status).toBe(200)
    const { flowId } = await started.json()
    const polled = await post('/api/oauth/device/poll', { flowId })
    expect(polled.status).toBe(200)
    expect(await polled.json()).toEqual({ status: 'connected' })
    await assertUpdated('codex')
  })

  test('a target belonging to another vendor is refused at initiation', async () => {
    const response = await post('/api/oauth/device/start', { targetAccountId: 'claude-target' })
    expect(response.status).toBe(400)
  })
})
