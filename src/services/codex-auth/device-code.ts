/**
 * Codex device-code sign-in (`codex login --device-auth`) — the upstream
 * calls only. The route layer (src/api/oauth/route.ts) owns the flow
 * state and the client-facing polling contract; this module just talks
 * to auth.openai.com.
 *
 * Captured from openai/codex codex-rs/login/src/device_code_auth.rs at
 * commit d4fcb2873bf23464cfacd804a31d46529db943b0:
 *
 *   1. POST {issuer}/api/accounts/deviceauth/usercode  { client_id }
 *        → { device_auth_id, user_code, interval }. The verification URL
 *        is NOT part of that response — the CLI builds it itself as
 *        `{issuer}/codex/device`, which is what we show too.
 *   2. Poll POST {issuer}/api/accounts/deviceauth/token
 *        { device_auth_id, user_code }
 *        200      → { authorization_code, code_challenge, code_verifier }.
 *                   The PKCE pair is minted server-side on THIS leg, not
 *                   by us — unlike the browser flow, we never generate
 *                   our own code_verifier for a device-code sign-in.
 *        403/404  → still pending; the CLI sleeps `interval` seconds and
 *                   retries, up to a 15-minute ceiling.
 *        anything else → failed.
 *   3. Exchange at the ordinary token endpoint:
 *        POST {issuer}/oauth/token, grant_type=authorization_code,
 *        redirect_uri={issuer}/deviceauth/callback, client_id,
 *        code_verifier from step 2. Reuses exchangeCodexCode from
 *        oauth.ts — the only difference from the browser flow is
 *        redirect_uri and where code_verifier comes from.
 */

import { logger } from '../../logger'
import { CodexDeviceTokenResponseSchema, CodexDeviceUserCodeResponseSchema } from '../../schemas/wire/oauth'
import { CODEX_CLIENT_ID, exchangeCodexCode } from './oauth'

const CODEX_ISSUER = 'https://auth.openai.com'
const DEVICE_USERCODE_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`
const DEVICE_TOKEN_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/token`
// Only has to match what step 2 hands back to the token endpoint, never
// be reachable — the same RFC 6749 rule the loopback flow relies on.
const DEVICE_REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`
// The CLI's struct defaults an absent `interval` field to 0 (u64's zero
// value), which would busy-loop the poll; fall back to a sane pace instead.
const DEFAULT_POLL_INTERVAL_SECONDS = 5
// Mirrors the CLI's own device-auth ceiling (`max_wait` in poll_for_token).
export const CODEX_DEVICE_CODE_TTL_MS = 15 * 60_000

const DEBUG_OAUTH = process.env.RIALTO_DEBUG_OAUTH === '1'

export interface CodexDeviceCode {
  deviceAuthId: string
  userCode: string
  verificationUri: string
  intervalSeconds: number
}

export const requestCodexDeviceCode = async (): Promise<CodexDeviceCode> => {
  const res = await fetch(DEVICE_USERCODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID })
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    logger.error({ status: res.status, responseBody: body }, '[codex-device] user-code request failed')
    throw new Error(`codex device-code request failed: ${res.status} ${body}`.trim())
  }
  const parsed = CodexDeviceUserCodeResponseSchema.safeParse(await res.json())
  if (!parsed.success) throw new Error('codex device-code request returned an unexpected payload')
  const userCode = parsed.data.user_code === undefined ? parsed.data.usercode : parsed.data.user_code
  if (userCode === undefined) throw new Error('codex device-code response carried neither user_code nor usercode')
  const rawInterval = parsed.data.interval
  const interval = rawInterval === undefined ? Number.NaN : Number(rawInterval)
  return {
    deviceAuthId: parsed.data.device_auth_id,
    userCode,
    verificationUri: `${CODEX_ISSUER}/codex/device`,
    intervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_POLL_INTERVAL_SECONDS
  }
}

export type CodexDevicePollResult =
  | { status: 'pending' }
  | { status: 'authorized'; code: string; codeVerifier: string }
  | { status: 'error'; message: string }

/** One poll of the device-auth token endpoint — the caller owns the interval / TTL loop. */
export const pollCodexDeviceCode = async (opts: {
  deviceAuthId: string
  userCode: string
}): Promise<CodexDevicePollResult> => {
  const res = await fetch(DEVICE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_auth_id: opts.deviceAuthId, user_code: opts.userCode })
  }).catch((err: unknown) => {
    logger.warn({ err }, '[codex-device] poll did not reach auth.openai.com; asking again next interval')
    return null
  })
  // No response says nothing about the code, so the flow keeps waiting: one
  // dropped connection must not end a sign-in the operator is part-way
  // through. The flow's own 15-minute expiry still bounds the retries.
  if (res === null) return { status: 'pending' }
  // 403/404 both mean "not yet entered" — the CLI treats them identically.
  if (res.status === 403 || res.status === 404) return { status: 'pending' }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (DEBUG_OAUTH) {
      logger.error({ status: res.status, responseBody: body }, '[codex-device] poll failed')
    } else {
      logger.error({ status: res.status }, '[codex-device] poll failed')
    }
    return { status: 'error', message: `device auth failed with status ${res.status}` }
  }
  const parsed = CodexDeviceTokenResponseSchema.safeParse(await res.json().catch(() => null))
  if (!parsed.success) return { status: 'error', message: 'codex device-code poll returned an unexpected payload' }
  return { status: 'authorized', code: parsed.data.authorization_code, codeVerifier: parsed.data.code_verifier }
}

/** Exchange an authorized device-code grant for tokens — same token endpoint as the browser flow. */
export const exchangeCodexDeviceCode = (opts: { code: string; codeVerifier: string }) =>
  exchangeCodexCode({ code: opts.code, codeVerifier: opts.codeVerifier, redirectUri: DEVICE_REDIRECT_URI })
