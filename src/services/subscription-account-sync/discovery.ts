/**
 * Build the in-memory DiscoveredAccount shape from an OAuth token
 * exchange (Claude profile / Codex id_token claims), plus the identity +
 * "which account is active" helpers used by the persist layer.
 */

import type { SubAccount } from '../../generated/prisma/client'
import dayjs from '../../lib/dayjs'
import { logger } from '../../logger'
import type { DiscoveredAccount } from '../../schemas/domain/subscription'
import type { ClaudeOAuthProfile } from '../../schemas/wire/oauth'
import { codexAccessTokenExpiry, codexIdentityFrom } from '../codex-auth/claims'
import { encryptString, firstString } from './crypto'
import { claudeMonthlyPrice, codexMonthlyPrice } from './pricing'

// Identity key used to match a discovered account against an existing
// SubAccount row. Stable across the synthetic sourcePath churn we used
// to see when an OAuth login re-issued a path-bearing identifier.
type StableIdentity = string

export const stableIdentityFor = (
  a: Pick<DiscoveredAccount | SubAccount, 'userId' | 'accountId' | 'sourcePath'>
): StableIdentity => a.userId ?? a.accountId ?? `path:${a.sourcePath}`

export const buildAccountPayload = (providerName: string, account: DiscoveredAccount, key: Buffer) => ({
  label: `${providerName}:${account.label}`,
  userName: account.userName,
  userEmail: account.userEmail,
  userId: account.userId,
  accountId: account.accountId,
  plan: account.plan,
  rateLimitTier: account.rateLimitTier,
  monthlyPriceUsd: account.monthlyPriceUsd,
  expiresAt: account.expiresAt,
  subscriptionEndsAt: account.subscriptionEndsAt,
  scopes: account.scopes,
  accessTokenEnc: encryptString(account.accessToken, key),
  refreshTokenEnc: encryptString(account.refreshToken, key),
  idTokenEnc: encryptString(account.idToken, key),
  lastSyncedAt: dayjs().toDate()
})

// Build the in-memory shape we used to read from ~/.claude/.credentials.json,
// from the tokens plus the /api/oauth/profile answer that proved them. The
// caller fetches the profile: connecting an account needs it as the proof,
// and fetching it a second time here could fail after the first had passed.
export const claudeAccountFromProfile = (
  tokens: {
    accessToken: string
    refreshToken: string
    expiresAt: number | null
    scopes: string[]
  },
  profile: ClaudeOAuthProfile
): DiscoveredAccount | null => {
  const userId = firstString(profile.account.uuid)
  if (!userId) {
    logger.warn('[subaccount] claude oauth: profile did not return account.uuid; cannot derive stable identity')
    return null
  }
  const expiresAt = tokens.expiresAt !== null ? dayjs(tokens.expiresAt).toDate() : null
  return {
    sourcePath: `oauth:claude:${userId}`,
    label: 'web-oauth',
    userName: firstString(profile.account.full_name, profile.account.display_name),
    userEmail: firstString(profile.account.email),
    userId,
    accountId: null,
    plan: firstString(profile.organization?.organization_type),
    rateLimitTier: firstString(profile.organization?.rate_limit_tier),
    monthlyPriceUsd: claudeMonthlyPrice(profile.account, profile.organization?.rate_limit_tier),
    expiresAt,
    // Anthropic exposes no subscription end date on the profile.
    subscriptionEndsAt: null,
    scopes: tokens.scopes,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    idToken: null
  }
}

// Codex identity comes off the id_token's claims rather than a profile
// endpoint. `accountId` may also arrive explicitly — ~/.codex/auth.json
// stores `tokens.account_id` next to the tokens, and an import that
// carries it should not need an id_token at all (chatmock reads the
// field first and only falls back to deriving it).
//
// `expiresAt` is the ACCESS TOKEN's expiry, same as the Claude path.
// The subscription's own end date is a separate fact and lives in
// `subscriptionEndsAt`; conflating the two here is what stopped every
// near-expiry refresh check from ever firing for Codex.
export const buildCodexDiscoveredAccount = (tokens: {
  accessToken: string
  refreshToken: string
  idToken: string | null
  accountId?: string | null
}): DiscoveredAccount | null => {
  const identity = codexIdentityFrom(tokens.idToken)
  if (tokens.idToken !== null && identity === null) {
    logger.warn('[subaccount] codex oauth: id_token claims could not be decoded')
  }
  const accountId = firstString(tokens.accountId, identity?.accountId)
  const userId = identity !== null ? identity.userId : null
  const stable = firstString(accountId, userId)
  if (stable === null) {
    logger.warn('[subaccount] codex oauth: no account_id, chatgpt_account_id or sub to key the account on')
    return null
  }
  const planType = identity !== null ? identity.planType : null
  return {
    sourcePath: `oauth:codex:${stable}`,
    label: 'web-oauth',
    userName: identity !== null ? identity.userName : null,
    userEmail: identity !== null ? identity.userEmail : null,
    userId,
    accountId,
    plan: planType,
    rateLimitTier: null,
    monthlyPriceUsd: codexMonthlyPrice(planType),
    expiresAt: codexAccessTokenExpiry(tokens.accessToken),
    subscriptionEndsAt: identity !== null ? identity.subscriptionEndsAt : null,
    scopes: [],
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    idToken: tokens.idToken
  }
}
