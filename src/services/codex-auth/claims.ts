/**
 * Readers for the JWT claims OpenAI issues to the Codex OAuth client.
 *
 * Both tokens carry claims we depend on:
 *   - id_token     → identity (account id, user, plan, subscription end)
 *   - access_token → `exp`, which is the ONLY authoritative statement of
 *     how long the bearer token is good for. The token endpoint's
 *     `expires_in` is a hint we only see at grant time; `exp` is readable
 *     off whatever token we currently hold, which is what lets a stored
 *     account self-diagnose without any bookkeeping column.
 *
 * Mirrors chatmock's `parse_jwt_claims` / `_derive_account_id` /
 * `_should_refresh_access_token` (chatmock/utils.py).
 *
 * Nothing here verifies the signature — these tokens come from our own
 * token exchange over TLS and are handed straight back to the issuer, so
 * the claims are read as metadata, never as an authorization decision.
 */

import dayjs from '../../lib/dayjs'

const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/**
 * Decode a JWT's payload segment without verifying the signature.
 * Returns null for anything that is not a well-formed JWT payload.
 */
export const decodeJwtPayload = (token: string | null): Record<string, unknown> | null => {
  if (token === null || token.length === 0) return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const segment = parts[1]
    const padded = segment
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(segment.length + ((4 - (segment.length % 4)) % 4), '=')
    const parsed: unknown = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

// The `https://api.openai.com/auth` namespaced claim block, or {}.
const claimsAuthSection = (claims: Record<string, unknown> | null): Record<string, unknown> => {
  if (claims === null) return {}
  const raw = claims[OPENAI_AUTH_CLAIM]
  return isRecord(raw) ? raw : {}
}

/**
 * Expiry stamped into an access_token's own `exp` claim.
 *
 * This is the first thing every freshness check consults: it stays
 * correct even when the DB column that mirrors it was written with a
 * different meaning (Codex rows used to store the SUBSCRIPTION end date
 * in `SubAccount.expiresAt`, which made every near-expiry check conclude
 * the hour-long access token was good for months).
 */
export const codexAccessTokenExpiry = (accessToken: string | null): Date | null => {
  const claims = decodeJwtPayload(accessToken)
  if (claims === null) return null
  const exp = claims.exp
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null
  return dayjs.unix(exp).toDate()
}

/** The official Codex identity parser uses these ChatGPT user claims, not JWT sub. */
export const codexChatgptUserId = (idToken: string | null): string | null => {
  const auth = claimsAuthSection(decodeJwtPayload(idToken))
  const userId = asString(auth.chatgpt_user_id)
  return userId !== null ? userId : asString(auth.user_id)
}

/** Identity + entitlement fields carried by a Codex id_token. */
export interface CodexIdentityClaims {
  accountId: string | null
  userId: string | null
  userName: string | null
  userEmail: string | null
  planType: string | null
  subscriptionEndsAt: Date | null
}

/**
 * Read the identity block out of an id_token. Returns null when the
 * token could not be decoded at all; individual fields are null when the
 * claim was absent.
 */
export const codexIdentityFrom = (idToken: string | null): CodexIdentityClaims | null => {
  const claims = decodeJwtPayload(idToken)
  if (claims === null) return null
  const auth = claimsAuthSection(claims)
  const activeUntil = asString(auth.chatgpt_subscription_active_until)
  const parsedActiveUntil = activeUntil !== null ? dayjs(activeUntil) : null
  return {
    accountId: asString(auth.chatgpt_account_id),
    userId: asString(claims.sub),
    userName: asString(claims.name),
    userEmail: asString(claims.email),
    planType: asString(auth.chatgpt_plan_type),
    subscriptionEndsAt: parsedActiveUntil?.isValid() ? parsedActiveUntil.toDate() : null
  }
}
