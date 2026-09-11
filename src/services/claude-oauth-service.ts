/**
 * Anthropic OAuth code-grant flow (PKCE) for the Web UI.
 *
 * Mirrors what `claude` CLI does on `claude login`: builds the
 * authorize URL pointing at the user's browser, then on the callback
 * exchanges the code for OAuth tokens. Persistence is handled by
 * subscription-connect-service.connectClaudeAccount — the tokens are
 * verified with Anthropic, then land encrypted in the DB; nothing is
 * written to disk.
 *
 * Client id + the refresh URL match the values already hardcoded in
 * `llms/transformers/anthropic/claude-code-oauth.ts` so the proxy keeps
 * working with the stored tokens.
 */

import { logger } from '../logger'
import { type OauthRefreshResponse, OauthRefreshResponseSchema } from '../schemas/wire/oauth'

// Diagnostic flag — set RIALTO_DEBUG_OAUTH=1 to log the token-exchange
// request body alongside the response on failure. Off by default to
// keep the `code` / `code_verifier` out of routine logs. The pre-rename
const DEBUG_OAUTH = process.env.RIALTO_DEBUG_OAUTH === '1'

// Loopback OAuth flow — the only redirect_uri pattern the Claude Code
// OAuth client allows (per the public metadata at
// https://claude.ai/oauth/claude-code-client-metadata). Port is
// wildcarded by Anthropic so we can use the same port the Rialto server
// is already listening on; path must be exactly `/callback`.
//
// Endpoint hosts copied verbatim from the strings table of the claude
// CLI binary (the user-facing claude.ai/oauth/authorize redirects to
// the same target):
//   - authorize: claude.com/cai/oauth/authorize
//   - token:     platform.claude.com/v1/oauth/token
const CLAUDE_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize'
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

// Order + composition copied verbatim from a real `claude login`
// authorize URL — Anthropic rejects the request with "Invalid request
// format" when `org:create_api_key` is missing, even though the
// downstream Rialto proxy never uses that scope.
export const CLAUDE_SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload'
]

export const buildClaudeAuthorizeUrl = (opts: {
  redirectUri: string
  state: string
  codeChallenge: string
}): string => {
  // `code=true` is the same load-bearing extra the CLI sends — drop it
  // and the page renders "Authorization failed / Invalid request format".
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLAUDE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: opts.redirectUri,
    scope: CLAUDE_SCOPES.join(' '),
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
    state: opts.state
  })
  return `${CLAUDE_AUTHORIZE_URL}?${params}`
}

interface TokenExchangeResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

const isTokenResponse = (value: unknown): value is TokenExchangeResponse => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.access_token === 'string' &&
    v.access_token.length > 0 &&
    typeof v.refresh_token === 'string' &&
    v.refresh_token.length > 0 &&
    typeof v.expires_in === 'number'
  )
}

/**
 * Trade a refresh token for a new grant. Throws when the token endpoint
 * refuses it or answers something unreadable — the same contract as
 * exchangeClaudeCode below; a caller that can live without the refresh
 * catches.
 */
export const refreshClaudeToken = async (refreshToken: string): Promise<OauthRefreshResponse> => {
  const res = await fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLAUDE_CLIENT_ID })
  })
  if (!res.ok) {
    // Only the status is logged: unlike the code exchange, this request
    // body is a live refresh token, debug flag or not.
    logger.warn({ status: res.status }, '[claude-oauth] token refresh failed')
    throw new Error(`claude token refresh failed: ${res.status}`)
  }
  const parsed = OauthRefreshResponseSchema.safeParse(await res.json())
  if (!parsed.success) throw new Error('claude token refresh returned an unexpected payload')
  return parsed.data
}

export const exchangeClaudeCode = async (opts: {
  code: string
  codeVerifier: string
  redirectUri: string
  state: string
}): Promise<TokenExchangeResponse> => {
  // Anthropic-specific extension to RFC 6749 §4.1.3: the authorization-
  // code grant's POST body must include `state` alongside the standard
  // fields. Without it, the token endpoint returns 400 with the
  // Anthropic envelope `{type:"error", error:{type:
  // "invalid_request_error", message:"Invalid request format"}}`.
  // Verified against the request shape baked into the official claude
  // CLI binary. JSON body, no anthropic-beta header — matches both
  // that CLI and the in-repo refresh path.
  // redirect_uri MUST be byte-identical to what authorize used; same
  // for state.
  const body = JSON.stringify({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: CLAUDE_CLIENT_ID,
    code_verifier: opts.codeVerifier,
    state: opts.state
  })
  const res = await fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  })
  if (!res.ok) {
    const respBody = await res.text().catch(() => '')
    if (DEBUG_OAUTH) {
      logger.error(
        {
          status: res.status,
          requestBody: body,
          responseBody: respBody,
          contentType: res.headers.get('content-type')
        },
        '[claude-oauth] token exchange failed'
      )
    } else {
      logger.error({ status: res.status, responseBody: respBody }, '[claude-oauth] token exchange failed')
    }
    throw new Error(`claude token exchange failed: ${res.status} ${respBody}`.trim())
  }
  const raw = await res.json()
  if (!isTokenResponse(raw)) {
    if (DEBUG_OAUTH) {
      logger.error({ raw }, '[claude-oauth] token response did not match expected shape')
    }
    throw new Error('claude token exchange returned an unexpected payload')
  }
  return raw
}
