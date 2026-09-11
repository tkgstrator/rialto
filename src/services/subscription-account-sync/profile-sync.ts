/**
 * Re-fetch profile data for all SubAccounts and update the DB in-place.
 * Claude: refreshes token first, then pulls /api/oauth/profile for name/plan/tier.
 * Codex: refreshes via ensureFreshCodexAccessToken (shared with the proxy
 * hot path and the usage poller, so the rotating refresh_token is never
 * raced), then calls wham/usage which returns the live plan_type and
 * updates plan + monthlyPriceUsd in-place. The id_token JWT baked in at
 * OAuth time is a static snapshot — wham/usage is the authoritative live
 * source.
 */

import { getPrismaClient } from '../../db/client'
import { AuthStatus, type PrismaClient } from '../../generated/prisma/client'
import dayjs from '../../lib/dayjs'
import { logger } from '../../logger'
import { OauthRefreshResponseSchema } from '../../schemas/wire/oauth'
import { fetchClaudeProfile } from '../claude-profile-service'
import { ensureFreshCodexAccessToken } from '../codex-auth/token'
import { decryptString, encryptionKey, encryptString, firstString } from './crypto'
import { providersForKind } from './persist'
import { claudeMonthlyPrice, codexMonthlyPrice } from './pricing'

const CLAUDE_REFRESH_URL = 'https://platform.claude.com/v1/oauth/token'
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const REFRESH_LEEWAY_MS = 5 * 60 * 1000

// Refresh the access token if it is expired or near expiry, persist the
// new grant to the DB, and return the usable token. Falls back to the
// original token on any error so callers always get something to try.
const ensureFreshClaudeToken = async (
  subAccountId: string,
  accessToken: string,
  refreshToken: string | null,
  expiresAt: Date | null,
  key: Buffer,
  prisma: PrismaClient
): Promise<string> => {
  const needsRefresh = expiresAt === null || expiresAt.valueOf() - Date.now() <= REFRESH_LEEWAY_MS
  if (!needsRefresh || !refreshToken) return accessToken
  try {
    const res = await fetch(CLAUDE_REFRESH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLAUDE_OAUTH_CLIENT_ID
      })
    })
    if (!res.ok) return accessToken
    const parsed = OauthRefreshResponseSchema.safeParse(await res.json())
    if (!parsed.success) return accessToken
    const { access_token, refresh_token, expires_in } = parsed.data
    const newExpiresAt = expires_in !== undefined ? new Date(Date.now() + expires_in * 1000) : null
    const newAccessEnc = encryptString(access_token, key)
    const newRefreshEnc = refresh_token ? encryptString(refresh_token, key) : undefined
    await prisma.subAccount.update({
      where: { id: subAccountId },
      data: {
        accessTokenEnc: newAccessEnc,
        ...(newRefreshEnc !== undefined ? { refreshTokenEnc: newRefreshEnc } : {}),
        expiresAt: newExpiresAt
      }
    })
    return access_token
  } catch {
    return accessToken
  }
}

// Persist the outcome of an auth probe. authCheckedAt is stamped on
// every call; authError is cleared on success and kept on failure so the
// UI can explain why an account needs re-authentication.
const recordAuthStatus = async (
  prisma: PrismaClient,
  subAccountId: string,
  status: AuthStatus,
  error: string | null
): Promise<void> => {
  await prisma.subAccount.update({
    where: { id: subAccountId },
    data: {
      authStatus: status,
      authCheckedAt: dayjs().toDate(),
      authError: status === AuthStatus.live ? null : error
    }
  })
}

export interface ProfileSyncScope {
  // Skip providers that are switched off. Off by default: the auth-health
  // job and POST /api/subscriptions/sync probe every account, so a
  // provider's accounts are known to authenticate before it is turned on.
  enabledProvidersOnly?: boolean
  // Only the provider with this name, switched on or not: the Refresh on
  // that provider's own page, which asks about nothing else.
  providerName?: string
}

export interface ProfileSyncResult {
  updated: number
  failed: number
  // The accounts behind `failed`. The counts were enough for the scheduled
  // job; a refresh a person clicked has to say which account it could not
  // reach, or "1 failed" over a list of ten sends them checking all ten.
  failedAccountIds: string[]
}

export async function syncSubAccountProfiles(
  prisma: PrismaClient = getPrismaClient(),
  scope: ProfileSyncScope = {}
): Promise<ProfileSyncResult> {
  const key = encryptionKey()
  const inScope = (p: { name: string; enabled: boolean }): boolean =>
    (scope.enabledProvidersOnly !== true || p.enabled) &&
    (scope.providerName === undefined || p.name === scope.providerName)
  const claudeProviders = (await providersForKind(prisma, 'claude')).filter(inScope)
  let updated = 0
  const failedAccountIds: string[] = []

  for (const p of claudeProviders) {
    const accounts = await prisma.subAccount.findMany({ where: { providerId: p.id } })
    for (const account of accounts) {
      const rawAccessToken = decryptString(account.accessTokenEnc, key)
      if (!rawAccessToken) {
        await recordAuthStatus(prisma, account.id, AuthStatus.invalid, 'No access token stored')
        failedAccountIds.push(account.id)
        continue
      }
      const refreshToken = decryptString(account.refreshTokenEnc, key)
      const accessToken = await ensureFreshClaudeToken(
        account.id,
        rawAccessToken,
        refreshToken,
        account.expiresAt,
        key,
        prisma
      )
      let profileStatus: number | null = null
      const profile = await fetchClaudeProfile(accessToken, {
        logger,
        onStatus: (s) => {
          profileStatus = s
        }
      })
      if (!profile) {
        // A dead refresh token leaves ensureFreshClaudeToken returning the
        // stale (expired) access token, so the profile fetch 401/403s — that
        // is the definitive "needs re-authentication" signal. Any other
        // failure (5xx, network) is transient, so leave the prior authStatus
        // untouched rather than flip a healthy account to invalid.
        if (profileStatus === 401 || profileStatus === 403) {
          await recordAuthStatus(prisma, account.id, AuthStatus.invalid, `Claude auth rejected (HTTP ${profileStatus})`)
        }
        failedAccountIds.push(account.id)
        continue
      }
      await prisma.subAccount.update({
        where: { id: account.id },
        data: {
          userName: firstString(profile.account.full_name, profile.account.display_name),
          userEmail: firstString(profile.account.email),
          plan: firstString(profile.organization?.organization_type),
          rateLimitTier: firstString(profile.organization?.rate_limit_tier),
          monthlyPriceUsd: claudeMonthlyPrice(profile.account, profile.organization?.rate_limit_tier),
          authStatus: AuthStatus.live,
          authCheckedAt: dayjs().toDate(),
          authError: null,
          lastSyncedAt: dayjs().toDate()
        }
      })
      updated++
    }
  }

  // Codex: call wham/usage for each account to get the live plan_type.
  const codexProviders = (await providersForKind(prisma, 'codex')).filter(inScope)
  for (const p of codexProviders) {
    const accounts = await prisma.subAccount.findMany({ where: { providerId: p.id } })
    for (const account of accounts) {
      const rawAccessToken = decryptString(account.accessTokenEnc, key)
      if (!rawAccessToken) {
        await recordAuthStatus(prisma, account.id, AuthStatus.invalid, 'No access token stored')
        failedAccountIds.push(account.id)
        continue
      }
      const accessToken = await ensureFreshCodexAccessToken(
        {
          subAccountId: account.id,
          accessToken: rawAccessToken,
          refreshToken: decryptString(account.refreshTokenEnc, key),
          expiresAt: account.expiresAt,
          lastSyncedAt: account.lastSyncedAt
        },
        prisma
      )
      try {
        const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
            ...(account.accountId ? { 'chatgpt-account-id': account.accountId } : {})
          }
        })
        if (!res.ok) {
          logger.warn({ status: res.status }, '[subaccount] codex wham/usage non-OK')
          // 401/403 means the rotated (or still-original) access token is
          // no longer accepted. ensureFreshCodexToken already tried to
          // refresh above — if we still land here, the refresh_token itself
          // is dead and the user must re-authenticate. Other statuses
          // (429, 5xx) are transient, so leave the prior authStatus intact.
          if (res.status === 401 || res.status === 403) {
            await recordAuthStatus(prisma, account.id, AuthStatus.invalid, `Codex auth rejected (HTTP ${res.status})`)
          }
          failedAccountIds.push(account.id)
          continue
        }
        const raw = (await res.json()) as Record<string, unknown>
        const planType = typeof raw.plan_type === 'string' && raw.plan_type.length > 0 ? raw.plan_type : null
        await prisma.subAccount.update({
          where: { id: account.id },
          data: {
            plan: planType ?? account.plan,
            monthlyPriceUsd: planType !== null ? codexMonthlyPrice(planType) : account.monthlyPriceUsd,
            authStatus: AuthStatus.live,
            authCheckedAt: dayjs().toDate(),
            authError: null,
            lastSyncedAt: dayjs().toDate()
          }
        })
        updated++
      } catch (err) {
        logger.warn({ err }, '[subaccount] codex wham/usage threw')
        // Network/transient error — leave the last known authStatus intact.
        failedAccountIds.push(account.id)
      }
    }
  }

  return { updated, failed: failedAccountIds.length, failedAccountIds }
}
