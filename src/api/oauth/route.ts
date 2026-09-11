/**
 * Web-UI OAuth flow for subscription providers (loopback).
 *
 *   POST /api/oauth/initiate/:provider   (admin gate)
 *     → { authorizeUrl, state }
 *     UI opens the URL in a NEW TAB. claude / codex's consent page
 *     redirects the browser back to the loopback callback the
 *     upstream OAuth client whitelists:
 *       - claude → http://localhost:<port>/callback
 *       - codex  → http://localhost:<port>/auth/callback
 *
 *   GET  /callback        (claude — intentionally public, root path)
 *   GET  /auth/callback   (codex  — intentionally public, root path)
 *     ← top-level browser redirect with `code` + `state`. We look up
 *     the pending flow by state, run the provider-specific token
 *     exchange, then connect the account (subscription-connect-service:
 *     verify with the vendor, store it live, read its windows).
 *
 *   POST /api/oauth/manual-callback   (admin gate)
 *     For every deployment where the browser cannot reach the loopback
 *     callback: a remote host, a tunnel, a container that does not
 *     publish the port. The UI instructs the user to copy the redirect
 *     URL out of the browser address bar and submit it here; the server
 *     extracts code+state and completes the exchange server-side.
 *     Handles BOTH providers. Codex needs it most — its redirect_uri is
 *     pinned to localhost:1455, which resolves on the BROWSER's machine,
 *     so any install the operator does not sit in front of has no other
 *     way through.
 *
 *   POST /api/oauth/device/start   (admin gate, Codex only)
 *   POST /api/oauth/device/poll    (admin gate, Codex only)
 *     Device-code sign-in (codex-auth/device-code.ts): Codex has no
 *     browser sign-in in this UI at all — its OAuth client only
 *     redirects to localhost:1455 on the BROWSER's machine, which a
 *     remote or containerised install never receives, so the loopback
 *     flow above needs the manual-callback escape hatch just to be
 *     usable. A device code needs nothing to reach back: /start asks
 *     auth.openai.com for a one-time code and returns it with a flowId;
 *     the UI shows the code and polls /poll on its own timer, at most
 *     once per upstream interval (see device-flow-store.ts), until the
 *     operator enters the code at auth.openai.com/codex/device. On
 *     `connected`, the grant is exchanged and connected exactly like the
 *     other Codex arrivals below.
 *
 *   POST /api/oauth/import-credentials   (admin gate)
 *     Accepts a raw credentials payload (or a parsed ~/.claude/.credentials.json
 *     / ~/.codex/auth.json object) and connects the account the same way,
 *     bypassing the OAuth dance entirely. Nothing is stored unless the
 *     vendor accepts the credentials.
 *
 *   POST /api/oauth/export-credentials   (admin gate)
 *     Symmetric to import-credentials — decrypts the ACTIVE SubAccount's
 *     tokens for the given kind and returns them in the on-disk file
 *     shape (claudeAiOauth wrapper for claude, tokens {access_token,
 *     refresh_token, id_token, account_id} for codex), so the payload
 *     round-trips straight back through import-credentials on another
 *     Rialto host.
 *
 * Pending flows live in a process-memory map (PoC scope). CSRF
 * protection is the single-use `state` token issued at /initiate;
 * /callback validates against that and rejects unknown / expired
 * states. The callback paths are intentionally outside `/api/*` so
 * the top-level redirect from the IdP isn't subject to adminAuth.
 */

import { Hono } from 'hono'
import { getPrismaClient } from '../../db/client'
import { logger } from '../../logger'
import {
  CodexDevicePollRequestSchema,
  type CodexDevicePollResponse,
  type CodexDeviceStartResponse
} from '../../schemas/api/oauth'
import { ClaudeCredentialsFileSchema, CodexCredentialsFileSchema } from '../../schemas/wire/oauth'
import { buildClaudeAuthorizeUrl, CLAUDE_SCOPES, exchangeClaudeCode } from '../../services/claude-oauth-service'
import { CODEX_CALLBACK_PORT, ensureCodexCallbackListener } from '../../services/codex-auth/callback-listener'
import {
  exchangeCodexDeviceCode,
  pollCodexDeviceCode,
  requestCodexDeviceCode
} from '../../services/codex-auth/device-code'
import {
  createDeviceFlow,
  deleteDeviceFlow,
  getDeviceFlow,
  markDeviceFlowPolled,
  setDeviceFlowPhase
} from '../../services/codex-auth/device-flow-store'
import { buildCodexAuthorizeUrl, CODEX_CALLBACK_PATH, exchangeCodexCode } from '../../services/codex-auth/oauth'
import {
  consumePendingFlow,
  generatePkcePair,
  generateState,
  storePendingFlow
} from '../../services/oauth-flow-service'
import { providersForKind } from '../../services/subscription-account-sync/persist'
import { getUsableSubAccountAuth } from '../../services/subscription-account-sync/read'
import {
  AccountConnectError,
  connectClaudeAccount,
  connectCodexAccount
} from '../../services/subscription-connect-service'

export const oauthRoute = new Hono()

const CLAUDE_CALLBACK_PATH = '/callback'

const PROVIDER_CALLBACK_PATH: Record<string, string> = {
  claude: CLAUDE_CALLBACK_PATH,
  codex: CODEX_CALLBACK_PATH
}

const isSupportedProvider = (p: string): p is 'claude' | 'codex' => p === 'claude' || p === 'codex'

oauthRoute.post('/api/oauth/initiate/:provider', async (c) => {
  const provider = c.req.param('provider')
  if (!isSupportedProvider(provider)) {
    return c.json({ success: false as const, error: `unsupported provider "${provider}"` }, 400)
  }

  const callbackPath = PROVIDER_CALLBACK_PATH[provider]
  const initiateUrl = new URL(c.req.url)
  const rialtoBaseUrl = `${initiateUrl.protocol}//${initiateUrl.host}`
  let redirectUri: string
  if (provider === 'codex') {
    // OpenAI's OAuth client only allows http://localhost:1455/auth/callback —
    // confirmed: any other loopback port returns unknown_error. So the
    // redirect_uri is fixed regardless of where this install runs.
    //
    // Binding the listener is best-effort, not a precondition. It can only
    // ever catch the redirect when the browser and this process share a
    // localhost — a workstation install, or a container that publishes 1455.
    // Everywhere else (remote host, tunnel, unpublished container) the
    // browser lands on a dead port with the code sitting in its address bar,
    // and /api/oauth/manual-callback completes the same exchange from the
    // pasted URL. Refusing to start the flow here used to take that fallback
    // away too, which left codex unusable on every deployment but one.
    await ensureCodexCallbackListener({ resultBaseUrl: rialtoBaseUrl }).catch((err: unknown) => {
      logger.warn({ err, port: CODEX_CALLBACK_PORT }, '[oauth] codex loopback listener unavailable; paste-back only')
    })
    redirectUri = `http://localhost:${CODEX_CALLBACK_PORT}${callbackPath}`
  } else {
    const isLoopback = initiateUrl.hostname === 'localhost' || initiateUrl.hostname === '127.0.0.1'
    if (isLoopback) {
      // Local access: use the loopback callback so the server handles the exchange automatically.
      const port = initiateUrl.port || process.env.PORT || '3456'
      redirectUri = `http://localhost:${port}${callbackPath}`
    } else {
      // Remote access (e.g. Cloudflare Tunnel): use Anthropic's own display callback.
      // Instead of redirecting the browser to an unreachable localhost, Anthropic shows
      // the authorization code on their platform page so the user can copy it manually.
      redirectUri = 'https://platform.claude.com/oauth/code/callback'
    }
  }

  const state = generateState()
  const { codeVerifier, codeChallenge } = generatePkcePair()
  storePendingFlow(state, { codeVerifier, redirectUri, provider, createdAt: Date.now() })

  const authorizeUrl =
    provider === 'claude'
      ? buildClaudeAuthorizeUrl({ redirectUri, state, codeChallenge })
      : buildCodexAuthorizeUrl({ redirectUri, state, codeChallenge })

  return c.json({ success: true as const, authorizeUrl, state })
})

// claude only — codex's callback is served by the standalone listener on
// port 1455 (see codex-auth/callback-listener.ts) because its OAuth client
// doesn't allow any other loopback port.
oauthRoute.get(CLAUDE_CALLBACK_PATH, async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const errorParam = c.req.query('error')

  const url = new URL(c.req.url)
  const baseUrl = `${url.protocol}//${url.host}`
  const resultUrl = (status: 'ok' | 'error', message?: string): string => {
    const p = new URLSearchParams({ status, provider: 'claude' })
    if (message) p.set('message', message)
    return `${baseUrl}/oauth-result?${p.toString()}`
  }

  if (errorParam) return c.redirect(resultUrl('error', `Upstream returned error: ${errorParam}`))
  if (typeof code !== 'string' || code.length === 0)
    return c.redirect(resultUrl('error', 'Missing `code` in callback URL.'))
  if (typeof state !== 'string' || state.length === 0)
    return c.redirect(resultUrl('error', 'Missing `state` in callback URL.'))

  const pending = consumePendingFlow(state)
  if (!pending) return c.redirect(resultUrl('error', 'Unknown or expired `state`. Start the flow again.'))
  if (pending.provider !== 'claude')
    return c.redirect(resultUrl('error', `State belongs to provider "${pending.provider}", not "claude".`))

  try {
    const tokens = await exchangeClaudeCode({
      code,
      codeVerifier: pending.codeVerifier,
      redirectUri: pending.redirectUri,
      state
    })
    await connectClaudeAccount({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      scopes: CLAUDE_SCOPES
    })
    return c.redirect(resultUrl('ok'))
  } catch (err) {
    logger.error({ err, provider: 'claude' }, '[oauth] callback failed')
    const message = err instanceof Error ? err.message : 'Unknown error during token exchange.'
    return c.redirect(resultUrl('error', message))
  }
})

// How a failed connection is answered. A refusal from connecting carries
// its own status — bad credentials are the caller's to fix, an unreachable
// vendor is not — and anything else stays the 500 it always was.
const connectFailure = (
  err: unknown,
  fallback: string
): { body: { success: false; error: string }; status: 400 | 500 | 502 } => {
  if (err instanceof AccountConnectError) return { body: { success: false, error: err.message }, status: err.status }
  return { body: { success: false, error: err instanceof Error ? err.message : fallback }, status: 500 }
}

// Start a Codex device-code sign-in: ask auth.openai.com for a one-time
// code, hold the flow server-side, and hand the UI just enough to render
// it and start polling. Codex only — no other vendor's CLI exposes this
// device-auth endpoint set, and nothing here allows a `provider` param.
oauthRoute.post('/api/oauth/device/start', async (c) => {
  try {
    const code = await requestCodexDeviceCode()
    const { flowId, expiresAt } = createDeviceFlow(code)
    return c.json({
      flowId,
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      expiresAt,
      intervalSeconds: code.intervalSeconds
    } satisfies CodexDeviceStartResponse)
  } catch (err) {
    logger.error({ err }, '[oauth] codex device-code start failed')
    const message = err instanceof Error ? err.message : 'Failed to start Codex device-code sign-in.'
    return c.json({ success: false as const, error: message }, 502)
  }
})

// One poll of an outstanding device-code flow. Client-driven: the UI times
// this itself (see the countdown / interval it got from /start), and this
// handler only forwards to auth.openai.com when the flow's own interval has
// elapsed (device-flow-store.ts) — a tab polling too eagerly, or a second
// tab on the same flow, answers from memory instead of doubling upstream
// calls. `pending` / `connected` / `expired` are ordinary 200s; a hard
// failure (bad flowId aside, which reads as `expired`) is the same 400/502
// `{ success, error }` shape every other /api/oauth/* route answers with.
oauthRoute.post('/api/oauth/device/poll', async (c) => {
  const body = await c.req.json<unknown>().catch(() => ({}))
  const parsed = CodexDevicePollRequestSchema.safeParse(body)
  if (!parsed.success) return c.json({ success: false as const, error: 'Missing `flowId`.' }, 400)

  const flow = getDeviceFlow(parsed.data.flowId)
  const expired: CodexDevicePollResponse = { status: 'expired' }
  const pending: CodexDevicePollResponse = { status: 'pending' }
  const connected: CodexDevicePollResponse = { status: 'connected' }
  if (flow === null) return c.json(expired)
  // Both answered from memory, before the expiry check: a sign-in that is
  // finishing or finished is not undone by the clock running out meanwhile.
  if (flow.phase === 'connected') return c.json(connected)
  if (flow.phase === 'completing') return c.json(pending)
  if (Date.now() >= flow.expiresAt) {
    deleteDeviceFlow(parsed.data.flowId)
    return c.json(expired)
  }
  if (Date.now() < flow.nextPollAt) return c.json(pending)

  // Claimed before the upstream call, not after: a poll that arrives while
  // this one is still waiting on auth.openai.com must answer `pending` from
  // memory. Otherwise both reach upstream, both can come back authorized,
  // and the second exchange of the single-use code fails the sign-in.
  markDeviceFlowPolled(parsed.data.flowId)
  const result = await pollCodexDeviceCode({ deviceAuthId: flow.deviceAuthId, userCode: flow.userCode })
  if (result.status === 'pending') return c.json(pending)
  if (result.status === 'error') {
    deleteDeviceFlow(parsed.data.flowId)
    return c.json({ success: false as const, error: result.message }, 502)
  }

  // Authorized. The exchange, the credential check and the first usage poll
  // take seconds, so the flow stays in the store as `completing` meanwhile
  // (see DeviceFlowPhase) instead of being dropped up front, where a poll
  // landing in those seconds found nothing and read `expired`.
  setDeviceFlowPhase(parsed.data.flowId, 'completing')
  try {
    const tokens = await exchangeCodexDeviceCode({ code: result.code, codeVerifier: result.codeVerifier })
    await connectCodexAccount({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token
    })
    setDeviceFlowPhase(parsed.data.flowId, 'connected')
    return c.json(connected)
  } catch (err) {
    // The grant's code is single-use and spent, so there is nothing to retry
    // on this flow: the error goes back once and later polls read `expired`.
    deleteDeviceFlow(parsed.data.flowId)
    logger.error({ err }, '[oauth] codex device-code exchange failed')
    const failure = connectFailure(err, 'Failed to complete Codex device-code sign-in.')
    return c.json(failure.body, failure.status)
  }
})

// Remote-deployment relay: the browser cannot reach the loopback callback
// when Rialto is hosted behind a reverse proxy, so the UI asks the user to
// copy the redirect URL and POST it here. Extracts code+state and runs the
// same token exchange as the loopback GET /callback handler above.
oauthRoute.post('/api/oauth/manual-callback', async (c) => {
  const body = await c.req.json<{ url?: string; code?: string; state?: string }>()

  let code: string | undefined
  let state: string | undefined

  if (typeof body.url === 'string' && body.url.length > 0) {
    const raw = body.url.trim()
    // Support three input formats:
    //   1. Full URL:   https://platform.claude.com/oauth/code/callback?code=...&state=...
    //   2. code#state: yA88L...#pj8oV...  (displayed by platform.claude.com)
    //   3. code only:  yA88L...           (state must be in body.state)
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      try {
        const parsed = new URL(raw)
        code = parsed.searchParams.get('code') ?? undefined
        state = parsed.searchParams.get('state') ?? undefined
      } catch {
        return c.json({ success: false as const, error: 'Invalid URL.' }, 400)
      }
    } else if (raw.includes('#')) {
      const [c_, s_] = raw.split('#', 2)
      code = c_
      state = s_
    } else {
      code = raw
      state = typeof body.state === 'string' ? body.state : undefined
    }
  } else {
    code = typeof body.code === 'string' ? body.code : undefined
    state = typeof body.state === 'string' ? body.state : undefined
  }

  if (!code) return c.json({ success: false as const, error: 'Missing `code` in URL.' }, 400)
  if (!state) return c.json({ success: false as const, error: 'Missing `state` in URL.' }, 400)

  const pending = consumePendingFlow(state)
  if (!pending)
    return c.json({ success: false as const, error: 'Unknown or expired state. Start the flow again.' }, 400)
  if (!isSupportedProvider(pending.provider))
    return c.json(
      { success: false as const, error: `State belongs to unsupported provider "${pending.provider}".` },
      400
    )
  const flowProvider = pending.provider

  try {
    // Codex reaches here far more often than claude does: its redirect_uri is
    // pinned to http://localhost:1455/auth/callback, so anything but a
    // browser on the server's own machine lands on a dead port. The exchange
    // does not care — RFC 6749 only requires redirect_uri to match the
    // authorize request byte-for-byte, never to be reachable from here.
    if (flowProvider === 'codex') {
      const tokens = await exchangeCodexCode({
        code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri
      })
      await connectCodexAccount({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token
      })
      return c.json({ success: true as const })
    }
    const tokens = await exchangeClaudeCode({
      code,
      codeVerifier: pending.codeVerifier,
      redirectUri: pending.redirectUri,
      state
    })
    await connectClaudeAccount({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      scopes: CLAUDE_SCOPES
    })
    return c.json({ success: true as const })
  } catch (err) {
    logger.error({ err, provider: flowProvider }, '[oauth] manual-callback failed')
    const failure = connectFailure(err, 'Unknown error during token exchange.')
    return c.json(failure.body, failure.status)
  }
})

// Bypass the OAuth dance: accept a raw credential payload and connect the
// account from it. Useful for remote deployments where the loopback
// callback is unreachable and the user already has a credentials file.
oauthRoute.post('/api/oauth/import-credentials', async (c) => {
  const body = await c.req.json<{ provider: string; credentials: unknown }>()

  // A payload the schema refuses is answered with the schema's own reasons.
  // "Not a credentials file" alone sent an operator hunting for a format
  // problem in a file that only lacked the field naming the account.
  const notCredentials = (vendor: 'Claude' | 'Codex', file: string, issues: readonly { message: string }[]) => ({
    success: false as const,
    error: `Not a ${vendor} credentials file (${file}): ${issues.map((issue) => issue.message).join('; ')}`
  })

  if (body.provider === 'claude') {
    const parsed = ClaudeCredentialsFileSchema.safeParse(body.credentials)
    if (!parsed.success) {
      return c.json(notCredentials('Claude', '~/.claude/.credentials.json', parsed.error.issues), 400)
    }
    const { accessToken, refreshToken, expiresAt, scopes } = parsed.data
    try {
      await connectClaudeAccount({
        accessToken,
        refreshToken,
        expiresAt: typeof expiresAt === 'number' ? expiresAt : null,
        scopes: scopes === undefined ? CLAUDE_SCOPES : scopes
      })
      return c.json({ success: true as const })
    } catch (err) {
      logger.error({ err }, '[oauth] import-credentials (claude) failed')
      const failure = connectFailure(err, 'Failed to record account.')
      return c.json(failure.body, failure.status)
    }
  }

  if (body.provider === 'codex') {
    const parsed = CodexCredentialsFileSchema.safeParse(body.credentials)
    if (!parsed.success) {
      return c.json(notCredentials('Codex', '~/.codex/auth.json', parsed.error.issues), 400)
    }
    try {
      await connectCodexAccount(parsed.data)
      return c.json({ success: true as const })
    } catch (err) {
      logger.error({ err }, '[oauth] import-credentials (codex) failed')
      const failure = connectFailure(err, 'Failed to record account.')
      return c.json(failure.body, failure.status)
    }
  }

  return c.json({ success: false as const, error: `Unsupported provider "${body.provider}".` }, 400)
})

// Symmetric to import-credentials: decrypt the ACTIVE SubAccount's
// tokens for the given kind and return them in the ~/.claude/.credentials.json
// / ~/.codex/auth.json wire shape — the exact bytes import-credentials
// accepts, so a backup taken from this endpoint round-trips into another
// Rialto (or the on-disk CLI file) without hand-editing.
//
// Response carries Content-Disposition: attachment with a stable
// filename so a browser download prompt fires; XHR / SDK callers keep
// the JSON body untouched. Cache-control: no-store because the body is
// secret material.
//
// Only the active account is exported — the same one the proxy hot path
// would use for outbound OAuth calls right now.
oauthRoute.post('/api/oauth/export-credentials', async (c) => {
  const body = await c.req.json<{ provider: string }>().catch(() => ({ provider: '' }))
  if (body.provider !== 'claude' && body.provider !== 'codex') {
    return c.json({ success: false as const, error: `Unsupported provider "${body.provider}".` }, 400)
  }
  const kind: 'claude' | 'codex' = body.provider
  const prisma = getPrismaClient()
  const kindProviders = await providersForKind(prisma, kind)
  if (kindProviders.length === 0) {
    return c.json({ success: false as const, error: `No subscription provider registered for "${kind}".` }, 404)
  }

  // Walk every provider that matches this vendor kind (usually one:
  // claude-code / codex) and take the first account that can
  // authenticate. With several connected accounts this exports one of
  // them, not "the" one: nothing designates an account any more, and the
  // proxy spreads traffic across all of them per request.
  for (const p of kindProviders) {
    const auth = await getUsableSubAccountAuth(p.name, prisma)
    if (!auth || !auth.accessToken) continue

    if (kind === 'claude') {
      const sub = await prisma.subAccount.findUnique({
        where: { id: auth.subAccountId },
        select: { scopes: true }
      })
      const rawScopes: unknown = sub?.scopes
      const scopes: string[] = Array.isArray(rawScopes)
        ? rawScopes.filter((s): s is string => typeof s === 'string')
        : []
      const file = {
        claudeAiOauth: {
          accessToken: auth.accessToken,
          refreshToken: auth.refreshToken ?? '',
          expiresAt: auth.expiresAt ? auth.expiresAt.valueOf() : null,
          scopes
        }
      }
      c.header('content-disposition', 'attachment; filename="claude-credentials.json"')
      c.header('cache-control', 'no-store')
      return c.json(file, 200)
    }

    // codex: an import needs SOMETHING to identify the account with —
    // either the id_token (claims carry chatgpt_account_id) or the
    // account_id itself. Emit both when we have them; refuse only when
    // neither is stored, since that payload would 400 straight back on
    // import and the operator has to re-OAuth to fix it.
    if (!auth.idToken && !auth.accountId) {
      logger.warn(
        { provider: p.name, subAccountId: auth.subAccountId },
        '[oauth] export-credentials: neither id_token nor account_id stored on codex account; re-authenticate to refresh'
      )
      return c.json(
        {
          success: false as const,
          error:
            'Stored codex account has no id_token or account_id to export (created before either was captured). Re-authenticate via Settings → Providers → Connect and retry.'
        },
        409
      )
    }
    const file = {
      tokens: {
        access_token: auth.accessToken,
        refresh_token: auth.refreshToken ?? '',
        ...(auth.idToken ? { id_token: auth.idToken } : {}),
        ...(auth.accountId ? { account_id: auth.accountId } : {})
      }
    }
    c.header('content-disposition', 'attachment; filename="codex-auth.json"')
    c.header('cache-control', 'no-store')
    return c.json(file, 200)
  }

  return c.json({ success: false as const, error: `No active subscription account for "${kind}".` }, 404)
})
