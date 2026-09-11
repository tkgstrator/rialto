/**
 * POST /api/oauth/manual-callback — the paste-back path, and the initiate
 * that has to keep working when the loopback listener cannot bind.
 *
 * Codex is why this exists. Its OAuth client pins redirect_uri to
 * `http://localhost:1455/auth/callback`, and `localhost` there means the
 * machine the BROWSER runs on — so on a container, a remote host or a
 * tunnelled install the consent page always lands on a dead port with the
 * code stranded in the address bar. The exchange itself does not care:
 * RFC 6749 only asks that redirect_uri match the authorize request
 * byte-for-byte, never that it be reachable from the server.
 *
 * Guards the two halves of that:
 *   - manual-callback runs the CODEX exchange for a codex flow (it used
 *     to reject anything that was not claude, which left codex with no
 *     way through on every deployment but a local one)
 *   - initiate still issues an authorize URL when :1455 is already taken,
 *     instead of 500ing away the paste-back fallback as well
 *
 * No DB: the stubbed token response carries an id_token with no account
 * claims, so connecting refuses the account before it asks the vendor
 * anything or touches Prisma. What is under test is the dispatch and the
 * exchange, both of which happen first.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { oauthRoute } from '../../src/api/oauth/route'
import { CODEX_CALLBACK_PORT } from '../../src/services/codex-auth/callback-listener'
import { storePendingFlow } from '../../src/services/oauth-flow-service'

const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CODEX_REDIRECT_URI = `http://localhost:${CODEX_CALLBACK_PORT}/auth/callback`

// A well-formed JWT whose payload carries no account/user claim, so the
// identity step declines to build an account and the persist layer is
// never reached. Signature is decorative — nothing verifies it.
const jwt = (payload: Record<string, unknown>): string =>
  ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.')

const originalFetch = globalThis.fetch

interface Captured {
  url: string
  body: string
}

const captured: Captured[] = []

// Replace the token endpoint with a canned response and record what was
// sent, so a test can prove WHICH vendor's exchange the route picked.
const stubToken = (status: number, payload: unknown): void => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = typeof init?.body === 'string' ? init.body : ''
    captured.push({ url, body })
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof globalThis.fetch
}

const post = (body: unknown): Promise<Response> =>
  oauthRoute.fetch(
    new Request('http://local/api/oauth/manual-callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  )

const seedFlow = (state: string, provider: 'claude' | 'codex'): void => {
  storePendingFlow(state, {
    codeVerifier: 'verifier-for-test',
    redirectUri: provider === 'codex' ? CODEX_REDIRECT_URI : 'https://platform.claude.com/oauth/code/callback',
    provider,
    createdAt: Date.now()
  })
}

describe('POST /api/oauth/manual-callback', () => {
  beforeEach(() => {
    captured.length = 0
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('unknown state is refused before any exchange', async () => {
    const res = await post({ url: 'http://localhost:1455/auth/callback?code=ac_x&state=never-issued' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toContain('expired')
    expect(captured).toHaveLength(0)
  })

  test('codex: a pasted dead-loopback URL runs the codex exchange with the pinned redirect_uri', async () => {
    seedFlow('state-codex-ok', 'codex')
    stubToken(200, {
      access_token: jwt({ exp: 4102444800 }),
      refresh_token: 'rt_codex',
      id_token: jwt({ iss: 'https://auth.openai.com' })
    })

    await post({ url: `${CODEX_REDIRECT_URI}?code=ac_pasted.value&scope=openid+profile&state=state-codex-ok` })

    // Assert the request that went upstream rather than the response: these
    // tokens carry no account id, so the connection after the exchange is
    // refused — the last case in this block pins that answer.
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe(CODEX_TOKEN_URL)
    const sent = new URLSearchParams(captured[0].body)
    expect(sent.get('grant_type')).toBe('authorization_code')
    expect(sent.get('code')).toBe('ac_pasted.value')
    expect(sent.get('code_verifier')).toBe('verifier-for-test')
    // Byte-identical to authorize's redirect_uri — the whole reason a
    // pasted URL can finish a flow the browser could not deliver.
    expect(sent.get('redirect_uri')).toBe(CODEX_REDIRECT_URI)
  })

  test('codex: an upstream rejection surfaces as 500, not as a provider mismatch', async () => {
    seedFlow('state-codex-bad', 'codex')
    stubToken(400, { error: 'invalid_grant' })

    const res = await post({ url: `${CODEX_REDIRECT_URI}?code=ac_expired&state=state-codex-bad` })

    expect(res.status).toBe(500)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.error).toContain('codex token exchange failed')
    expect(captured[0].url).toBe(CODEX_TOKEN_URL)
  })

  test('claude: still routed to the claude exchange', async () => {
    seedFlow('state-claude', 'claude')
    stubToken(400, { error: 'invalid_grant' })

    const res = await post({ url: 'https://platform.claude.com/oauth/code/callback?code=cl_x&state=state-claude' })

    expect(res.status).toBe(500)
    expect(captured[0].url).toBe(CLAUDE_TOKEN_URL)
  })

  test('a state minted for neither vendor is refused', async () => {
    storePendingFlow('state-alien', {
      codeVerifier: 'v',
      redirectUri: 'http://localhost:1/cb',
      provider: 'gemini',
      createdAt: Date.now()
    })

    const res = await post({ url: 'http://localhost:1/cb?code=x&state=state-alien' })

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('gemini')
    expect(captured).toHaveLength(0)
  })

  test('codex: an exchange whose tokens carry no account id is refused, not reported as connected', async () => {
    seedFlow('state-codex-anon', 'codex')
    stubToken(200, {
      access_token: jwt({ exp: 4102444800 }),
      refresh_token: 'rt_codex',
      id_token: jwt({ iss: 'https://auth.openai.com' })
    })

    const res = await post({ url: `${CODEX_REDIRECT_URI}?code=ac_pasted.value&state=state-codex-anon` })

    // This used to answer 200 while storing nothing, and the add-provider
    // screen announced a connection that had not happened.
    expect(res.status).toBe(400)
    const body: { error: string } = await res.json()
    expect(body.error).toContain('no account id')
    // Refused off the tokens alone: no vendor probe followed the exchange.
    expect(captured).toHaveLength(1)
  })
})

describe('POST /api/oauth/initiate/codex with :1455 already taken', () => {
  // Occupy the port BEFORE the route tries it, so ensureCodexCallbackListener
  // is guaranteed to fail to bind. It therefore never installs its own
  // listener or its 10-minute idle timer, and nothing is left holding the
  // event loop open when this file finishes.
  const squatter: { server: Server | null } = { server: null }

  beforeEach(
    () =>
      new Promise<void>((resolve, reject) => {
        const s = createServer((_req, res) => res.end('squatter'))
        s.once('error', reject)
        s.listen(CODEX_CALLBACK_PORT, '127.0.0.1', () => {
          squatter.server = s
          resolve()
        })
      })
  )

  afterEach(
    () =>
      new Promise<void>((resolve) => {
        if (squatter.server === null) {
          resolve()
          return
        }
        squatter.server.close(() => resolve())
        squatter.server = null
      })
  )

  test('still issues an authorize URL so the paste-back path stays reachable', async () => {
    const res = await oauthRoute.fetch(
      new Request('http://localhost:16175/api/oauth/initiate/codex', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; authorizeUrl: string; state: string }
    expect(body.success).toBe(true)
    expect(body.state.length).toBeGreaterThan(0)
    const authorize = new URL(body.authorizeUrl)
    expect(authorize.searchParams.get('redirect_uri')).toBe(CODEX_REDIRECT_URI)
  })
})
