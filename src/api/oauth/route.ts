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
import { logger } from '../../logger'
import { buildClaudeAuthorizeUrl, CLAUDE_SCOPES, exchangeClaudeCode } from '../../services/claude-oauth-service'
import { CODEX_CALLBACK_PORT, ensureCodexCallbackListener } from '../../services/codex-auth/callback-listener'
import { buildCodexAuthorizeUrl, CODEX_CALLBACK_PATH, exchangeCodexCode } from '../../services/codex-auth/oauth'
import {
  completeOAuthFlow,
  consumePendingFlow,
  generatePkcePair,
  generateState,
  oauthFlowResult,
  storePendingFlow
} from '../../services/oauth-flow-service'
import { connectClaudeAccount, connectCodexAccount } from '../../services/subscription-connect-service'
import { connectFailure } from './connect-failure'
import { registerCredentialRoutes } from './credential-routes'
import { registerDeviceRoutes } from './device-routes'
import { requestedReauthenticationTarget } from './reauthentication-target'

export const oauthRoute = new Hono()

oauthRoute.get('/api/oauth/status/:state', (c) => {
  c.header('cache-control', 'no-store')
  return c.json(oauthFlowResult(c.req.param('state')))
})

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

  const target = await requestedReauthenticationTarget(provider, await c.req.json().catch(() => ({}))).then(
    (id) => ({ id }),
    (err: unknown) => ({ failure: connectFailure(err, 'Failed to start reauthentication.') })
  )
  if ('failure' in target) return c.json(target.failure.body, target.failure.status)
  const targetAccountId = target.id
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
  storePendingFlow(state, { codeVerifier, redirectUri, provider, createdAt: Date.now(), targetAccountId })

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

  if (errorParam) {
    if (state) {
      consumePendingFlow(state)
      completeOAuthFlow(state, `Upstream returned error: ${errorParam}`)
    }
    return c.redirect(resultUrl('error', `Upstream returned error: ${errorParam}`))
  }
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
    await connectClaudeAccount(
      {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        scopes: CLAUDE_SCOPES
      },
      undefined,
      pending.targetAccountId
    )
    completeOAuthFlow(state)
    return c.redirect(resultUrl('ok'))
  } catch (err) {
    logger.error({ err, provider: 'claude' }, '[oauth] callback failed')
    const message = err instanceof Error ? err.message : 'Unknown error during token exchange.'
    completeOAuthFlow(state, message)
    return c.redirect(resultUrl('error', message))
  }
})

// Remote-deployment relay: the browser cannot reach the loopback callback
// when Rialto is hosted behind a reverse proxy, so the UI asks the user to
// copy the redirect URL and POST it here. Extracts code+state and runs the
// same token exchange as the loopback GET /callback handler above.
oauthRoute.post('/api/oauth/manual-callback', async (c) => {
  const body = await c.req.json<{ url?: string; code?: string; state?: string; expectedState?: string }>()

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
  if (body.expectedState !== undefined && body.expectedState !== state) {
    return c.json(
      {
        success: false as const,
        error: 'This callback belongs to a different sign-in attempt. Paste the code or URL from this attempt.'
      },
      400
    )
  }

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
      await connectCodexAccount(
        {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          idToken: tokens.id_token
        },
        undefined,
        pending.targetAccountId
      )
      completeOAuthFlow(state)
      return c.json({ success: true as const })
    }
    const tokens = await exchangeClaudeCode({
      code,
      codeVerifier: pending.codeVerifier,
      redirectUri: pending.redirectUri,
      state
    })
    await connectClaudeAccount(
      {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        scopes: CLAUDE_SCOPES
      },
      undefined,
      pending.targetAccountId
    )
    completeOAuthFlow(state)
    return c.json({ success: true as const })
  } catch (err) {
    logger.error({ err, provider: flowProvider }, '[oauth] manual-callback failed')
    completeOAuthFlow(state, err instanceof Error ? err.message : 'Authentication failed.')
    const failure = connectFailure(err, 'Unknown error during token exchange.')
    return c.json(failure.body, failure.status)
  }
})

registerDeviceRoutes(oauthRoute)
registerCredentialRoutes(oauthRoute)
