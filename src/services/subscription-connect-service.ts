/**
 * Connecting a subscription account: prove the credentials with the
 * vendor, store the account as live, then read its windows.
 *
 * Every way an account arrives — the Claude loopback callback, the Codex
 * callback listener, a pasted redirect URL, an imported credentials file —
 * used to write the row straight away and leave the rest to the background
 * jobs. That went wrong twice over:
 *   - Nothing checked that the credentials authenticate. Codex keys an
 *     account on the id in the file alone, so any token under one became
 *     an account reading `auth unknown` until the fifteen-minute health job
 *     marked it invalid; a Claude file whose profile call failed was dropped
 *     without a word while the route still answered success.
 *   - Its quota stayed empty until the next five-minute usage tick.
 *
 * So nothing is written until the vendor has accepted the credentials. One
 * refresh is tried when the access token is refused: a credentials file is
 * routinely older than its access token, and turning away one whose
 * refresh token still works would reject a working account.
 */

import { getPrismaClient } from '../db/client'
import { AuthStatus, type PrismaClient } from '../generated/prisma/client'
import dayjs from '../lib/dayjs'
import { logger } from '../logger'
import type { DiscoveredAccount } from '../schemas/domain/subscription'
import type { ClaudeOAuthProfile } from '../schemas/wire/oauth'
import { refreshClaudeToken } from './claude-oauth-service'
import { fetchClaudeProfile } from './claude-profile-service'
import { refreshCodexToken } from './codex-auth/oauth'
import {
  buildCodexDiscoveredAccount,
  claudeAccountFromProfile,
  recordDiscoveredAccount
} from './subscription-account-sync-service'
import { refreshAccountUsage } from './subscription-refresh-service'

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

/**
 * A connection refused on purpose. `status` is what the route answers with
 * — bad credentials are the caller's to fix (400), an unreachable vendor is
 * not (502) — and the message is written for the operator to read as is.
 */
export class AccountConnectError extends Error {
  readonly status: 400 | 502

  constructor(status: 400 | 502, message: string) {
    super(message)
    this.name = 'AccountConnectError'
    this.status = status
  }
}

// What one credential check found. Only a 401 / 403 is a verdict on the
// credentials; a 5xx, a timeout or no network says nothing about them, and
// storing an account on that would be a guess.
type Probe<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'rejected'; status: number }
  | { kind: 'unreachable'; status: number | null }

type Refusal = Exclude<Probe<unknown>, { kind: 'ok' }>

const isRefusal = (status: number | null): status is 401 | 403 => status === 401 || status === 403

// Probe with the access token as given and, when the vendor refuses it and
// a refresh token came along, trade that once and probe again.
const verify = async <Tokens extends { refreshToken: string }, T>(
  tokens: Tokens,
  probe: (tokens: Tokens) => Promise<Probe<T>>,
  refresh: (tokens: Tokens) => Promise<Tokens | null>
): Promise<{ tokens: Tokens; probe: Probe<T> }> => {
  const first = await probe(tokens)
  if (first.kind !== 'rejected' || tokens.refreshToken.length === 0) return { tokens, probe: first }
  const rotated = await refresh(tokens)
  if (rotated === null) return { tokens, probe: first }
  return { tokens: rotated, probe: await probe(rotated) }
}

const refusalError = (vendor: 'Claude' | 'Codex', probe: Refusal): AccountConnectError =>
  probe.kind === 'rejected'
    ? new AccountConnectError(
        400,
        `${vendor} rejected these credentials (HTTP ${probe.status}). Sign in again, or import a fresh credentials file.`
      )
    : new AccountConnectError(
        502,
        `Could not verify these credentials with ${vendor} (${probe.status === null ? 'no response' : `HTTP ${probe.status}`}). Nothing was saved; try again.`
      )

// Write the verified account, mark it live, then read its windows.
const storeVerified = async (
  kind: 'claude' | 'codex',
  account: DiscoveredAccount,
  prismaOverride: PrismaClient | undefined
): Promise<string[]> => {
  // Resolved only now, so credentials refused above never needed a database.
  const prisma = prismaOverride === undefined ? getPrismaClient() : prismaOverride
  const ids = await recordDiscoveredAccount(kind, account, prisma)
  if (ids.length === 0) {
    const vendor = kind === 'claude' ? 'Claude' : 'Codex'
    throw new AccountConnectError(
      400,
      `There is no ${vendor} subscription provider to add this account to. Add the provider first.`
    )
  }
  // The vendor accepted these credentials a moment ago, so the account is
  // live now rather than `unknown` until the health job's next pass.
  await prisma.subAccount.updateMany({
    where: { id: { in: ids } },
    data: { authStatus: AuthStatus.live, authCheckedAt: dayjs().toDate(), authError: null }
  })
  // The account is connected whatever happens here: a failed first poll is
  // the usage job's to retry, not a reason to report the connection failed.
  try {
    const failed = await refreshAccountUsage(ids, prisma)
    if (failed.length > 0) {
      logger.warn({ subAccountIds: failed }, '[subaccount] connected, but the first usage poll failed')
    }
  } catch (err) {
    logger.warn({ err, subAccountIds: ids }, '[subaccount] connected, but writing the first usage poll failed')
  }
  return ids
}

export interface ClaudeConnectTokens {
  accessToken: string
  refreshToken: string
  /** Epoch ms the access token expires, when known. */
  expiresAt: number | null
  scopes: string[]
}

const probeClaude = async (tokens: ClaudeConnectTokens): Promise<Probe<ClaudeOAuthProfile>> => {
  const seen: { status: number | null } = { status: null }
  const profile = await fetchClaudeProfile(tokens.accessToken, {
    logger,
    onStatus: (status) => {
      seen.status = status
    }
  })
  if (profile !== null) return { kind: 'ok', value: profile }
  const status = seen.status
  return isRefusal(status) ? { kind: 'rejected', status } : { kind: 'unreachable', status }
}

const refreshClaude = async (tokens: ClaudeConnectTokens): Promise<ClaudeConnectTokens | null> => {
  try {
    const grant = await refreshClaudeToken(tokens.refreshToken)
    return {
      accessToken: grant.access_token,
      // A grant may come back without a new refresh token; the one just
      // traded stays in that case.
      refreshToken: grant.refresh_token === undefined ? tokens.refreshToken : grant.refresh_token,
      expiresAt: grant.expires_in === undefined ? null : dayjs().add(grant.expires_in, 'second').valueOf(),
      scopes: tokens.scopes
    }
  } catch {
    return null
  }
}

export async function connectClaudeAccount(tokens: ClaudeConnectTokens, prisma?: PrismaClient): Promise<string[]> {
  const result = await verify(tokens, probeClaude, refreshClaude)
  if (result.probe.kind !== 'ok') throw refusalError('Claude', result.probe)
  const account = claudeAccountFromProfile(result.tokens, result.probe.value)
  if (account === null) {
    throw new AccountConnectError(
      502,
      'Claude accepted these credentials, but its profile carried no account id to key the account on.'
    )
  }
  return storeVerified('claude', account, prisma)
}

export interface CodexConnectTokens {
  accessToken: string
  refreshToken: string
  idToken: string | null
  accountId?: string | null
}

const probeCodex =
  (accountId: string | null) =>
  async (tokens: CodexConnectTokens): Promise<Probe<null>> => {
    try {
      const res = await fetch(CODEX_USAGE_URL, {
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          'content-type': 'application/json',
          ...(accountId === null ? {} : { 'chatgpt-account-id': accountId })
        }
      })
      // Only the status is a verdict; the usage poll after connecting reads
      // the body for real.
      await res.body?.cancel().catch(() => {})
      // 429 is the vendor throttling a token it did accept.
      if (res.ok || res.status === 429) return { kind: 'ok', value: null }
      const status = res.status
      return isRefusal(status) ? { kind: 'rejected', status } : { kind: 'unreachable', status }
    } catch {
      return { kind: 'unreachable', status: null }
    }
  }

const refreshCodex = async (tokens: CodexConnectTokens): Promise<CodexConnectTokens | null> => {
  try {
    const grant = await refreshCodexToken({ refreshToken: tokens.refreshToken })
    return {
      accessToken: grant.access_token,
      refreshToken: grant.refresh_token,
      idToken: grant.id_token === undefined ? tokens.idToken : grant.id_token,
      // The grant re-issues tokens, not the file's account_id, so it carries over.
      accountId: tokens.accountId
    }
  } catch {
    return null
  }
}

export async function connectCodexAccount(tokens: CodexConnectTokens, prisma?: PrismaClient): Promise<string[]> {
  // Codex identity is read off the tokens themselves, so it is settled
  // before the vendor is asked: credentials that cannot be keyed to an
  // account should not spend an upstream call, or a refresh token, first.
  const keyed = buildCodexDiscoveredAccount(tokens)
  if (keyed === null) {
    throw new AccountConnectError(
      400,
      'These Codex credentials carry no account id (tokens.account_id, or an id_token with chatgpt_account_id), so there is no account to connect.'
    )
  }
  const result = await verify(tokens, probeCodex(keyed.accountId), refreshCodex)
  if (result.probe.kind !== 'ok') throw refusalError('Codex', result.probe)
  // Rebuilt from the tokens that passed, so a rotated grant's own expiry is
  // what gets stored.
  const account = buildCodexDiscoveredAccount(result.tokens)
  if (account === null) {
    throw new AccountConnectError(
      502,
      'Codex refreshed these credentials, but the new grant could not be keyed to an account.'
    )
  }
  return storeVerified('codex', account, prisma)
}
