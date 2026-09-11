/**
 * POST /api/oauth/device/start and POST /api/oauth/device/poll — the
 * Codex device-code sign-in the Providers → Connect screen drives by
 * default now that Codex has no browser sign-in in the UI.
 *
 *   - start returns a flowId + the code to show, straight from the
 *     upstream user-code response
 *   - poll answers `pending` while the vendor still says "not yet
 *     entered", without spending more than one upstream call per flow
 *     tick (the interval-throttling in device-flow-store.ts)
 *   - poll answers `connected` once the vendor issues a grant AND the
 *     account can be verified and stored — success → account connected
 *   - an unknown / expired flowId reads as `expired`, not an error
 *   - a hard upstream failure (bad HTTP status from the poll endpoint,
 *     or the vendor refusing the exchanged credentials) surfaces as the
 *     same `{ success: false, error }` 400/502 shape every other
 *     /api/oauth/* route uses
 *
 * The first group needs no database; `connected` does.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { oauthRoute } from '../../src/api/oauth/route'
import { getPrismaClient } from '../../src/db/client'
import { AuthMode, AuthStatus } from '../../src/generated/prisma/client'
import { decryptString, encryptionKey } from '../../src/services/subscription-account-sync/crypto'
import { __clearUsageCachesForTest } from '../../src/services/usage-service'
import { HAS_DB, resetDbTables, teardownPrisma } from '../db/helpers'

const TEST_KEY_HEX = 'ab'.repeat(32)

const USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode'
const TOKEN_POLL_URL = 'https://auth.openai.com/api/accounts/deviceauth/token'
const TOKEN_EXCHANGE_URL = 'https://auth.openai.com/oauth/token'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
const jwt = (payload: Record<string, unknown>): string =>
  `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.sig`
const codexIdToken = jwt({
  sub: 'user-codex',
  email: 'codex@example.com',
  'https://api.openai.com/auth': { chatgpt_account_id: 'acc-codex', chatgpt_plan_type: 'plus' }
})
const codexUsageBody = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 10, reset_at: 4_102_462_800, limit_window_seconds: 18_000 },
    secondary_window: { used_percent: 20, reset_at: 4_103_049_600, limit_window_seconds: 604_800 }
  }
}

const originalFetch = globalThis.fetch
const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const calls: string[] = []
const stubUpstream = (routes: Record<string, (url: string) => Response | Promise<Response>>): void => {
  const fake = async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input)
    calls.push(url)
    const respond = routes[url]
    if (respond === undefined) throw new Error(`unexpected fetch to ${url}`)
    return respond(url)
  }
  globalThis.fetch = fake as typeof globalThis.fetch
}

const start = (): Promise<Response> =>
  oauthRoute.fetch(new Request('http://local/api/oauth/device/start', { method: 'POST' }))

const poll = (flowId: string): Promise<Response> =>
  oauthRoute.fetch(
    new Request('http://local/api/oauth/device/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flowId })
    })
  )

describe('POST /api/oauth/device/start', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    calls.length = 0
  })

  test('returns the code and verification URL straight off the upstream response', async () => {
    stubUpstream({
      [USERCODE_URL]: () => jsonResponse({ device_auth_id: 'da_1', user_code: 'KQ7M-P4TZ', interval: '5' })
    })

    const res = await start()

    expect(res.status).toBe(200)
    const body: {
      flowId: string
      userCode: string
      verificationUri: string
      expiresAt: number
      intervalSeconds: number
    } = await res.json()
    expect(body.userCode).toBe('KQ7M-P4TZ')
    expect(body.verificationUri).toBe('https://auth.openai.com/codex/device')
    expect(body.intervalSeconds).toBe(5)
    expect(body.flowId.length).toBeGreaterThan(0)
    expect(body.expiresAt).toBeGreaterThan(Date.now())
  })

  test('an upstream failure is reported, not a stack trace', async () => {
    stubUpstream({ [USERCODE_URL]: () => jsonResponse({ error: 'server_error' }, 500) })
    const res = await start()
    expect(res.status).toBe(502)
    const body: { success: boolean; error: string } = await res.json()
    expect(body.success).toBe(false)
  })
})

describe('POST /api/oauth/device/poll — no flow', () => {
  test('an unknown flowId reads as expired, not an error', async () => {
    const res = await poll('never-issued')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'expired' })
  })

  test('a missing flowId is a 400', async () => {
    const res = await oauthRoute.fetch(
      new Request('http://local/api/oauth/device/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /api/oauth/device/poll — with a started flow', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    calls.length = 0
  })

  const startFlow = async (interval = '0'): Promise<string> => {
    stubUpstream({
      [USERCODE_URL]: () => jsonResponse({ device_auth_id: 'da_x', user_code: 'CODE-XYZ', interval })
    })
    const res = await start()
    const body: { flowId: string } = await res.json()
    return body.flowId
  }

  test('still pending upstream reads as pending', async () => {
    const flowId = await startFlow()
    stubUpstream({ [TOKEN_POLL_URL]: () => jsonResponse({}, 403) })

    const res = await poll(flowId)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'pending' })
  })

  test('an upstream poll failure is a hard error, and the flow is dropped', async () => {
    const flowId = await startFlow()
    stubUpstream({ [TOKEN_POLL_URL]: () => jsonResponse({ error: 'server_error' }, 500) })

    const res = await poll(flowId)
    expect(res.status).toBe(502)

    // Dropped: polling the same flowId again answers `expired`, not
    // another upstream call.
    const second = await poll(flowId)
    expect(await second.json()).toEqual({ status: 'expired' })
  })

  test('a poll that cannot reach auth.openai.com keeps the flow waiting', async () => {
    const flowId = await startFlow()
    stubUpstream({
      [TOKEN_POLL_URL]: () => {
        throw new TypeError('fetch failed')
      }
    })

    const res = await poll(flowId)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'pending' })

    // Not dropped: the next poll still finds the flow rather than `expired`.
    const second = await poll(flowId)
    expect(await second.json()).toEqual({ status: 'pending' })
  })
})

describe.skipIf(!HAS_DB)('POST /api/oauth/device/poll — connected (DB)', () => {
  beforeEach(async () => {
    process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY = TEST_KEY_HEX
    await resetDbTables()
    __clearUsageCachesForTest()
    calls.length = 0
    const prisma = getPrismaClient()
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

  const startFlow = async (): Promise<string> => {
    stubUpstream({
      [USERCODE_URL]: () => jsonResponse({ device_auth_id: 'da_ok', user_code: 'CODE-OK', interval: '0' })
    })
    const res = await start()
    const body: { flowId: string } = await res.json()
    return body.flowId
  }

  test('a code the operator entered is exchanged and the account connected live', async () => {
    const flowId = await startFlow()
    stubUpstream({
      [TOKEN_POLL_URL]: () =>
        jsonResponse({ authorization_code: 'ac_device', code_challenge: 'cc', code_verifier: 'cv_device' }),
      [TOKEN_EXCHANGE_URL]: () =>
        jsonResponse({ access_token: 'at_device', refresh_token: 'rt_device', id_token: codexIdToken }),
      [CODEX_USAGE_URL]: () => jsonResponse(codexUsageBody)
    })

    const res = await poll(flowId)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'connected' })

    const prisma = getPrismaClient()
    const row = await prisma.subAccount.findFirstOrThrow()
    expect(row.authStatus).toBe(AuthStatus.live)
    expect(decryptString(row.accessTokenEnc, encryptionKey())).toBe('at_device')
    expect(decryptString(row.refreshTokenEnc, encryptionKey())).toBe('rt_device')

    // The token endpoint saw the device flow's own redirect_uri and the
    // server-minted code_verifier, not the browser flow's PKCE pair.
    const exchangeCall = calls.filter((u) => u === TOKEN_EXCHANGE_URL)
    expect(exchangeCall).toHaveLength(1)

    // A later poll hears the same answer, without exchanging the spent code again.
    const second = await poll(flowId)
    expect(await second.json()).toEqual({ status: 'connected' })
    expect(calls.filter((u) => u === TOKEN_EXCHANGE_URL)).toHaveLength(1)
  })

  test('a poll landing while the account is being stored reads pending, not expired', async () => {
    const flowId = await startFlow()
    const gate = { started: (): void => undefined, release: (): void => undefined }
    const exchangeStarted = new Promise<void>((resolve) => {
      gate.started = resolve
    })
    const exchangeReleased = new Promise<void>((resolve) => {
      gate.release = resolve
    })
    stubUpstream({
      [TOKEN_POLL_URL]: () =>
        jsonResponse({ authorization_code: 'ac_device', code_challenge: 'cc', code_verifier: 'cv_device' }),
      [TOKEN_EXCHANGE_URL]: async () => {
        gate.started()
        await exchangeReleased
        return jsonResponse({ access_token: 'at_device', refresh_token: 'rt_device', id_token: codexIdToken })
      },
      [CODEX_USAGE_URL]: () => jsonResponse(codexUsageBody)
    })

    const first = poll(flowId)
    await exchangeStarted
    const during = await poll(flowId)
    expect(await during.json()).toEqual({ status: 'pending' })

    gate.release()
    expect(await (await first).json()).toEqual({ status: 'connected' })
  })

  test('an account the vendor refuses is reported, not silently dropped', async () => {
    const flowId = await startFlow()
    stubUpstream({
      [TOKEN_POLL_URL]: () =>
        jsonResponse({ authorization_code: 'ac_device', code_challenge: 'cc', code_verifier: 'cv_device' }),
      [TOKEN_EXCHANGE_URL]: () =>
        // No `sub` and no account claim: nothing to key the account on.
        jsonResponse({
          access_token: 'at_device',
          refresh_token: 'rt_device',
          id_token: jwt({ iss: 'https://auth.openai.com' })
        })
    })

    const res = await poll(flowId)

    // Tokens with no account claim cannot be keyed to an account at all.
    expect(res.status).toBe(400)
    const body: { success: boolean; error: string } = await res.json()
    expect(body.error).toContain('no account id')
    expect(await getPrismaClient().subAccount.count()).toBe(0)
  })
})
