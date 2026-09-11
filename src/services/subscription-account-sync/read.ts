/**
 * Read path for the proxy: decrypt and hand back the tokens of a usable
 * SubAccount, plus the refresh-result writeback used after a rotation.
 */

import { getPrismaClient } from '../../db/client'
import { AuthMode, type PrismaClient, type SubAccount } from '../../generated/prisma/client'
import dayjs from '../../lib/dayjs'
import { decryptString, encryptionKey, encryptString, firstString } from './crypto'

export interface UsableSubAccountAuth {
  subAccountId: string
  accessToken: string | null
  refreshToken: string | null
  idToken: string | null
  accountId: string | null
  expiresAt: Date | null
}

// Read path for the proxy: decrypt and return the tokens of a usable
// SubAccount on `providerName`. "Usable" is enabled with a decryptable
// access token, taken in id order so the answer is stable across calls
// — an unordered findMany returns Postgres heap order, which shifts
// every time a token refresh rewrites a row.
//
// This used to read the provider's `activeSubscriptionAccountId`, a
// single promoted row. Nothing designates an account any more: ordinary
// traffic is spread across accounts per request by
// session-account-router, and the callers left here (catalog sync,
// probes, credential export) only need *a* credential that works.
// Returns null when the provider has no such account. The subAccountId
// comes back so the caller can hand it to updateSubAccountAccessToken
// after a refresh.
export async function getUsableSubAccountAuth(
  providerName: string,
  prisma: PrismaClient = getPrismaClient()
): Promise<UsableSubAccountAuth | null> {
  const provider = await prisma.provider.findUnique({
    where: { name: providerName },
    include: { subscriptionAccounts: { where: { enabled: true }, orderBy: { id: 'asc' } } }
  })
  if (!provider) return null
  const key = encryptionKey()
  for (const account of provider.subscriptionAccounts) {
    const accessToken = decryptString(account.accessTokenEnc, key)
    if (!accessToken) continue
    return {
      subAccountId: account.id,
      accessToken,
      refreshToken: decryptString(account.refreshTokenEnc, key),
      idToken: decryptString(account.idTokenEnc, key),
      accountId: account.accountId,
      expiresAt: account.expiresAt
    }
  }
  return null
}

// Refresh-result writeback: encrypt + persist a freshly-rotated token
// pair onto the named SubAccount. Used by transformer refresh code paths
// to keep the DB the single source of truth after a token grant rotation.
//
// `idToken` is written when the grant returned one. Codex refreshes
// re-issue the id_token alongside the access token, and dropping it left
// the stored copy frozen at OAuth time — which is what /export-credentials
// hands back for re-import elsewhere.
export async function updateSubAccountAccessToken(
  subAccountId: string,
  next: {
    accessToken: string
    refreshToken?: string | null
    idToken?: string | null
    expiresAt?: Date | null
  },
  prisma: PrismaClient = getPrismaClient()
): Promise<void> {
  const key = encryptionKey()
  const data: Record<string, unknown> = {
    accessTokenEnc: encryptString(next.accessToken, key),
    lastSyncedAt: dayjs().toDate()
  }
  if (typeof next.refreshToken === 'string' && next.refreshToken.length > 0) {
    data.refreshTokenEnc = encryptString(next.refreshToken, key)
  }
  if (typeof next.idToken === 'string' && next.idToken.length > 0) {
    data.idTokenEnc = encryptString(next.idToken, key)
  }
  if (next.expiresAt !== undefined) {
    data.expiresAt = next.expiresAt
  }
  await prisma.subAccount.update({ where: { id: subAccountId }, data })
}

export interface SubAccountTokenInfo {
  subAccountId: string
  displayName: string
  accessToken: string
  refreshToken: string | null
  accountId: string | null
  expiresAt: Date | null
}

// Which usage endpoint answers for a subscription provider, read off its
// base URL. Null for any other host, which no usage endpoint covers.
const usageKindOf = (apiBaseUrl: string): 'claude' | 'codex' | null => {
  if (apiBaseUrl.includes('anthropic.com')) return 'claude'
  if (apiBaseUrl.includes('chatgpt.com') || apiBaseUrl.includes('openai.com/v1')) return 'codex'
  return null
}

// An account whose access token does not decrypt has nothing to call
// upstream with, so it is left out rather than handed over empty.
const tokenInfoOf = (account: SubAccount, key: Buffer): SubAccountTokenInfo | null => {
  const accessToken = decryptString(account.accessTokenEnc, key)
  if (!accessToken) return null
  const name = firstString(account.userName, account.userEmail, account.userId)
  return {
    subAccountId: account.id,
    displayName: name === null ? 'Account' : name,
    accessToken,
    refreshToken: decryptString(account.refreshTokenEnc, key),
    accountId: account.accountId,
    expiresAt: account.expiresAt
  }
}

const hasToken = (info: SubAccountTokenInfo | null): info is SubAccountTokenInfo => info !== null

// Return decrypted tokens for all enabled SubAccounts of the given
// vendor kind on enabled providers. This is the pool the per-request
// account picker and the reactive 429 rotation draw from, so a provider
// the operator switched off contributes nothing to it — the same
// switch that keeps its models out of the registry. The usage poller and
// the Subscriptions list's Refresh read the same pool, so a switched-off
// provider is neither routed to nor polled by either; only the Refresh on
// its own page reads it, through getSubAccountTokensForProvider.
export async function getSubAccountTokensForKind(
  kind: 'claude' | 'codex',
  prisma: PrismaClient = getPrismaClient()
): Promise<SubAccountTokenInfo[]> {
  // Ordered explicitly because session-account-router's tie-break used to
  // fall through to this list's order, and an unordered findMany returns
  // Postgres heap order — which shifts every time a row is UPDATEd (a
  // token refresh rewrites accessTokenEnc), so "the first account" was
  // neither stable nor anyone's decision.
  const all = await prisma.provider.findMany({
    where: { authMode: AuthMode.subscription, enabled: true },
    orderBy: { name: 'asc' },
    include: { subscriptionAccounts: { where: { enabled: true }, orderBy: { id: 'asc' } } }
  })
  const key = encryptionKey()
  return all
    .filter((provider) => usageKindOf(provider.apiBaseUrl) === kind)
    .flatMap((provider) => provider.subscriptionAccounts.map((account) => tokenInfoOf(account, key)))
    .filter(hasToken)
}

// One provider's accounts, for the Refresh on that provider's own page.
// Unlike the pool above it does not ask Provider.enabled: nothing routes
// from this list, and a switched-off provider is the one whose
// credentials an operator most wants checked before switching it back
// on. Disabled accounts stay out, as they do of every poll. Split by kind
// so it can go straight to the usage poll; null when no subscription
// provider has the name.
export async function getSubAccountTokensForProvider(
  providerName: string,
  prisma: PrismaClient = getPrismaClient()
): Promise<{ claude: SubAccountTokenInfo[]; codex: SubAccountTokenInfo[] } | null> {
  const provider = await prisma.provider.findFirst({
    where: { name: providerName, authMode: AuthMode.subscription },
    include: { subscriptionAccounts: { where: { enabled: true }, orderBy: { id: 'asc' } } }
  })
  if (provider === null) return null
  const key = encryptionKey()
  const accounts = provider.subscriptionAccounts.map((account) => tokenInfoOf(account, key)).filter(hasToken)
  const kind = usageKindOf(provider.apiBaseUrl)
  return { claude: kind === 'claude' ? accounts : [], codex: kind === 'codex' ? accounts : [] }
}
