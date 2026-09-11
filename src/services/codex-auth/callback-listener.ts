/**
 * Loopback callback listener for the codex web-UI OAuth flow.
 *
 * OpenAI's OAuth client `app_EMoamEEZ73f0CkXaXp7hrann` rejects any
 * loopback redirect_uri other than `http://localhost:1455/auth/callback`
 * (the `codex login` CLI's hard-coded target). We can't reuse the
 * main Rialto port for it, so this module spins up a tiny standalone
 * node:http listener on 1455 whenever a codex flow is initiated;
 * the listener self-closes after an idle timeout.
 *
 * After the server-side token exchange + DB upsert finishes, the
 * listener 302-redirects the browser back to the Rialto SPA at
 * `<resultBaseUrl>/oauth-result?status=...` so the user sees the same
 * React result page the claude flow lands on. The base URL is provided
 * by `ensureCodexCallbackListener({ resultBaseUrl })` on every initiate
 * (so the most recent SPA origin always wins).
 *
 * Behaviour:
 *   - First `ensureCodexCallbackListener()` call binds
 *     `CODEX_CALLBACK_HOST`:1455 and resolves once `listen` succeeds.
 *   - Subsequent calls reset the idle timer and update the result base
 *     URL.
 *   - EADDRINUSE on 1455 (e.g. the user is also running `codex login`
 *     in a shell) surfaces as a warning; the initiate proceeds anyway
 *     and the operator finishes through the manual-callback paste box.
 *     There is no second port to fall back to — the OAuth client allows
 *     exactly one.
 *
 * A deployment where the browser and the server are not the same machine
 * (any remote install, and every containerised one that does not publish
 * this port) can never receive this redirect: `localhost` in the consent
 * page's redirect_uri means the BROWSER's machine. That case is served by
 * POST /api/oauth/manual-callback, which runs the same exchange from a
 * pasted URL — the redirect_uri only has to be byte-identical to the one
 * authorize saw, not reachable.
 */

import { createServer, type Server, type ServerResponse } from 'node:http'
import { logger } from '../../logger'
import { consumePendingFlow } from '../oauth-flow-service'
import { connectCodexAccount } from '../subscription-connect-service'
import { exchangeCodexCode } from './oauth'

export const CODEX_CALLBACK_PORT = 1455

// Which interface the listener binds. Loopback by default: on a workstation
// the browser and the server share it, and a callback that mints credentials
// has no business being reachable from anywhere else. A container cannot use
// loopback — Docker's published-port proxy connects to the container's
// EXTERNAL interface, so a 127.0.0.1 bind stays invisible from the host even
// with `-p 1455:1455`. The shipped image therefore sets
// CODEX_CALLBACK_HOST=0.0.0.0 and compose.yaml publishes the port back onto
// the host's own loopback (`127.0.0.1:1455:1455`), which keeps the listener
// off the LAN.
const configuredCallbackHost = process.env.CODEX_CALLBACK_HOST
export const CODEX_CALLBACK_HOST =
  configuredCallbackHost === undefined || configuredCallbackHost === '' ? '127.0.0.1' : configuredCallbackHost

// 10 minutes — long enough to cover the slowest interactive sign-in
// (SSO chain, MFA, etc.) without leaving the port grabbed forever
// once the user has wandered off.
const IDLE_SHUTDOWN_MS = 10 * 60_000

let server: Server | null = null
let stopTimer: ReturnType<typeof setTimeout> | null = null
let resultBaseUrl = ''

const bumpStopTimer = (): void => {
  if (stopTimer) clearTimeout(stopTimer)
  stopTimer = setTimeout(() => {
    if (!server) return
    server.close(() => {
      logger.info('[codex-callback] listener closed (idle)')
    })
    server = null
    stopTimer = null
  }, IDLE_SHUTDOWN_MS)
}

const redirectToResult = (res: ServerResponse, status: 'ok' | 'error', message?: string): void => {
  const params = new URLSearchParams({ status, provider: 'codex' })
  if (message) params.set('message', message)
  const url = `${resultBaseUrl}/oauth-result?${params.toString()}`
  res.writeHead(302, { Location: url })
  res.end()
}

const handleCallback = async (
  res: ServerResponse,
  params: { code: string | null; state: string | null; errorParam: string | null }
): Promise<void> => {
  const { code, state, errorParam } = params
  if (errorParam) {
    redirectToResult(res, 'error', `Upstream returned error: ${errorParam}`)
    return
  }
  if (!code || !state) {
    redirectToResult(res, 'error', 'Missing `code` or `state` in callback URL.')
    return
  }
  const pending = consumePendingFlow(state)
  if (!pending) {
    redirectToResult(res, 'error', 'Unknown or expired `state`. Start the flow again.')
    return
  }
  if (pending.provider !== 'codex') {
    redirectToResult(res, 'error', `State belongs to provider "${pending.provider}", not "codex".`)
    return
  }
  try {
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
    redirectToResult(res, 'ok')
  } catch (err) {
    logger.error({ err }, '[codex-callback] token exchange failed')
    const message = err instanceof Error ? err.message : 'Unknown error during token exchange.'
    redirectToResult(res, 'error', message)
  }
}

export const ensureCodexCallbackListener = (opts: { resultBaseUrl: string }): Promise<void> => {
  resultBaseUrl = opts.resultBaseUrl
  if (server) {
    bumpStopTimer()
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const s = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${CODEX_CALLBACK_HOST}:${CODEX_CALLBACK_PORT}`)
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
        return
      }
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const errorParam = url.searchParams.get('error')
      void handleCallback(res, { code, state, errorParam })
    })
    s.once('error', (err) => {
      logger.warn({ err, port: CODEX_CALLBACK_PORT }, '[codex-callback] listener failed to bind')
      reject(err)
    })
    s.listen(CODEX_CALLBACK_PORT, CODEX_CALLBACK_HOST, () => {
      logger.info({ port: CODEX_CALLBACK_PORT }, '[codex-callback] listener bound')
      server = s
      bumpStopTimer()
      resolve()
    })
  })
}
