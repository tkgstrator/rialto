/**
 * Access tokens for /v1/*.
 *
 * Replaces the single envelope APIKEY for machine traffic. Three things
 * the single key could not do, which are the reasons this exists:
 * revoke one client without cutting off the rest, attribute a request to
 * a client, and route one client differently from another.
 *
 * The plaintext is generated, returned once, and never stored — only its
 * sha256. A database read therefore cannot hand out working credentials,
 * and "show me the token again" is answered with "issue a new one".
 *
 * Verification is on the hot path of every /v1 request, so resolved
 * tokens are cached by hash. The cache holds negative results too: an
 * unauthenticated flood would otherwise be a database query per request.
 */

import { getPrismaClient } from '../db/client'
import dayjs from '../lib/dayjs'
import { invalidateTokenCache, mintSecret, PLAN_LIMITS_SELECT } from './access-token-auth'
import { SPEND_WINDOW_DAYS, spendByToken, type TokenWindowTotals } from './access-token-spend'
import {
  hasAnyLimit,
  planLimitsOf,
  readUsageWindows,
  resetUsageWindows,
  type WindowReport
} from './usage-window-service'

export { invalidateTokenCache, type ResolvedToken, resolveAccessToken, type TokenPlan } from './access-token-auth'
export type { TokenSpendGroup, TokenWindowTotals } from './access-token-spend'

export interface AccessTokenRow {
  id: string
  name: string
  prefix: string
  /** Surfaces this token may call. Empty means every surface. */
  surfaces: string[]
  profileKey: string | null
  lastUsedAt: string | null
  requestCount: number
  // USD spent by this token's traffic over SPEND_WINDOW_DAYS, priced
  // from the retained RequestLog rows. Null when nothing of this
  // token's traffic could be priced — no rows in the window, request
  // capture switched off, or no scraped price for the models it hit
  // (which is every subscription-auth model). Deliberately NOT a
  // lifetime figure: `requestCount` is a counter that survives log
  // retention and this is not, so pairing them would invite reading a
  // pruned window as a cheaper client.
  costUsd: number | null
  // Input / output tokens this token's traffic moved over the SAME
  // trailing window the cost above is priced from — not over its
  // lifetime, for exactly the reason `costUsd` is not. Null when the
  // window holds no rows for this token at all (no traffic, capture off,
  // or the rows aged out of retention); a token that did serve traffic
  // the logs still remember reports a real number, and 0 then means 0.
  // Kept separate from `costUsd`'s null, which additionally covers
  // "logged but unpriceable" — a subscription model has token counts and
  // no price.
  inputTokens: number | null
  outputTokens: number | null
  expiresAt: string | null
  // When the current secret was minted, if it is not the original one.
  // Rotation preserves the row, so `createdAt` is the age of the client
  // binding and this is the age of the credential it presents.
  rotatedAt: string | null
  createdAt: string
  /** The plan this token spends under. Null = unrestricted. */
  plan: { id: string; name: string } | null
}

export { SPEND_WINDOW_DAYS, sumSpendByToken, sumTokensByToken } from './access-token-spend'

export interface IssuedToken {
  token: AccessTokenRow
  /** Shown once. Never recoverable — reissue is the only path back. */
  plaintext: string
}

// The relation every wire row carries: which plan the token spends under.
const WIRE_INCLUDE = {
  plan: { select: { id: true, name: true } }
} as const

const toWire = (
  row: {
    id: string
    name: string
    prefix: string
    surfaces: string[]
    profileKey: string | null
    lastUsedAt: Date | null
    requestCount: number
    expiresAt: Date | null
    rotatedAt: Date | null
    createdAt: Date
    plan?: { id: string; name: string } | null
  },
  totals: TokenWindowTotals | undefined = undefined
): AccessTokenRow => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  surfaces: row.surfaces,
  profileKey: row.profileKey,
  lastUsedAt: row.lastUsedAt === null ? null : row.lastUsedAt.toISOString(),
  requestCount: row.requestCount,
  costUsd: totals === undefined ? null : totals.costUsd,
  inputTokens: totals === undefined ? null : totals.inputTokens,
  outputTokens: totals === undefined ? null : totals.outputTokens,
  expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
  rotatedAt: row.rotatedAt === null ? null : row.rotatedAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
  plan: row.plan === undefined || row.plan === null ? null : { id: row.plan.id, name: row.plan.name }
})

/**
 * What revoked tokens' traffic still weighs in the spend window.
 *
 * Revoking deletes the row, but the RequestLog rows it authenticated
 * keep its id. Without this, a per-token breakdown built from the list
 * alone would drop that spend, and every surviving token's share of the
 * window would read larger than it was. Null when the window holds none.
 */
export interface RevokedTokensTotals {
  /** Requests over the same trailing window the cost is priced from. */
  requestCount: number
  costUsd: number | null
}

export async function listAccessTokens(): Promise<{
  tokens: AccessTokenRow[]
  revoked: RevokedTokensTotals | null
}> {
  const [rows, spend] = await Promise.all([
    getPrismaClient().accessToken.findMany({ orderBy: { createdAt: 'desc' }, include: WIRE_INCLUDE }),
    spendByToken()
  ])
  const live = new Set(rows.map((row) => row.id))
  const gone = [...spend].filter(([id]) => !live.has(id))
  return { tokens: rows.map((row) => toWire(row, spend.get(row.id))), revoked: await revokedTotals(gone) }
}

async function revokedTotals(gone: readonly [string, TokenWindowTotals][]): Promise<RevokedTokensTotals | null> {
  if (gone.length === 0) return null
  const priced = gone.flatMap(([, totals]) => (totals.costUsd === null ? [] : [totals.costUsd]))
  const requestCount = await getPrismaClient().requestLog.count({
    where: {
      accessTokenId: { in: gone.map(([id]) => id) },
      createdAt: { gte: dayjs().subtract(SPEND_WINDOW_DAYS, 'day').toDate() }
    }
  })
  return { requestCount, costUsd: priced.length === 0 ? null : priced.reduce((sum, cost) => sum + cost, 0) }
}

/** One token by id, priced the same way the list prices it. */
export async function getAccessToken(id: string): Promise<AccessTokenRow | null> {
  const row = await getPrismaClient()
    .accessToken.findUnique({ where: { id }, include: WIRE_INCLUDE })
    .catch(() => null)
  if (row === null) return null
  const spend = await spendByToken(id)
  return toWire(row, spend.get(id))
}

export interface IssueInput {
  name: string
  /** Omitted or empty scopes the token to every surface. */
  surfaces?: string[]
  profileKey?: string | null
  expiresAt?: string | null
  /** The plan the token spends under. Omitted or null = unrestricted. */
  planId?: string | null
}

export async function issueAccessToken(input: IssueInput): Promise<IssuedToken> {
  const { plaintext, tokenHash, prefix } = mintSecret()
  const row = await getPrismaClient().accessToken.create({
    data: {
      name: input.name,
      tokenHash,
      prefix,
      surfaces: input.surfaces === undefined ? [] : input.surfaces,
      profileKey: input.profileKey === undefined ? null : input.profileKey,
      expiresAt: input.expiresAt === undefined || input.expiresAt === null ? null : new Date(input.expiresAt),
      planId: input.planId === undefined ? null : input.planId
    },
    include: WIRE_INCLUDE
  })
  invalidateTokenCache()
  return { token: toWire(row), plaintext }
}

export interface UpdateInput {
  /** Replaces the scope wholesale. Empty means every surface. */
  surfaces?: string[]
  profileKey?: string | null
  /** Moves the token onto a plan, or off every plan with null. */
  planId?: string | null
}

/**
 * Change what an existing token is allowed to do.
 *
 * Scope and routing profile are the two things about a token that
 * legitimately change after it is issued — a client picks up a second
 * endpoint, or its traffic should start following a different chain —
 * and neither is a reason to hand the machine a new secret. The name,
 * the secret and the expiry are deliberately not editable here: the
 * first is cosmetic, and the other two have their own operations
 * (`rotateAccessToken`, re-issue) whose consequences differ.
 *
 * Clears the resolver cache, without which a widened scope would take up
 * to CACHE_TTL_MS to admit the client and a narrowed one would keep
 * admitting it for just as long.
 */
export async function updateAccessToken(id: string, input: UpdateInput): Promise<AccessTokenRow | null> {
  const row = await getPrismaClient()
    .accessToken.update({
      where: { id },
      data: {
        ...(input.surfaces === undefined ? {} : { surfaces: input.surfaces }),
        ...(input.profileKey === undefined ? {} : { profileKey: input.profileKey }),
        ...(input.planId === undefined ? {} : { planId: input.planId })
      },
      include: WIRE_INCLUDE
    })
    .catch(() => null)
  invalidateTokenCache()
  return row === null ? null : toWire(row)
}

/**
 * Why a rotation was refused. Rotation replaces the secret in place, so
 * the only sensible answers for a token that cannot authenticate anyway
 * are "no" and a reason — minting a new secret onto an expired row would
 * hand back a credential that is dead the moment it is copied. A revoked
 * token has no row left, so it is simply not found.
 */
export type RotateRefusal = 'not-found' | 'expired'

export type RotateResult = { ok: true; issued: IssuedToken } | { ok: false; reason: RotateRefusal }

/**
 * Replace a token's secret, keeping the row.
 *
 * The id, name, scope, expiry, request count and every RequestLog row
 * pointing at this token survive — which is the point. Re-issuing splits
 * one client's history across two rows and leaves the operator to
 * remember that "CI (old)" and "CI" were the same machine; rotating
 * keeps the identity and changes only what the client presents.
 *
 * The previous secret stops working immediately: its hash is gone from
 * the row, and the resolver cache is cleared so an in-flight positive
 * result cannot outlive it by up to CACHE_TTL_MS.
 */
export async function rotateAccessToken(id: string): Promise<RotateResult> {
  const existing = await getPrismaClient()
    .accessToken.findUnique({ where: { id } })
    .catch(() => null)
  if (existing === null) return { ok: false, reason: 'not-found' }
  if (existing.expiresAt !== null && existing.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' }
  }

  const { plaintext, tokenHash, prefix } = mintSecret()
  const row = await getPrismaClient().accessToken.update({
    where: { id },
    data: { tokenHash, prefix, rotatedAt: dayjs().toDate() },
    include: WIRE_INCLUDE
  })
  invalidateTokenCache()
  return { ok: true, issued: { token: toWire(row), plaintext } }
}

/**
 * Revoke a token: delete its row, so it stops authenticating and stops
 * being listed. There is no revoked state to keep. A row that could never
 * authenticate again was only ever kept so past RequestLog rows could show
 * its name, and the list it lingered in answers "what can reach the proxy
 * now". Those log rows keep the id (RequestLog.accessTokenId is not a
 * foreign key), so they still group as one client and the Activity screen
 * falls back to the surface's client name; their spend stays in the Usage
 * breakdown as one revoked-tokens line (listAccessTokens).
 */
export async function deleteAccessToken(id: string): Promise<boolean> {
  const done = await getPrismaClient()
    .accessToken.delete({ where: { id } })
    .then(() => true)
    .catch(() => false)
  invalidateTokenCache()
  return done
}

/**
 * Record that a token served a request.
 *
 * Fire-and-forget on the hot path: usage statistics are never worth
 * failing or delaying a proxied call for. Writes go straight to the DB
 * rather than through the cache, which only holds identity.
 */
export function noteTokenUse(id: string): void {
  getPrismaClient()
    .accessToken.update({ where: { id }, data: { lastUsedAt: new Date(), requestCount: { increment: 1 } } })
    .catch(() => {
      // A dropped statistic is not a reason to disturb the request.
    })
}

/** A token's usage windows against its plan's limits, as the admin page shows them. */
export interface TokenUsageWindows {
  /** False when the token's plan sets no limit (or it has no plan): nothing is counted. */
  limited: boolean
  windows: WindowReport[]
}

/** Null when there is no such token. */
export async function getTokenUsageWindows(id: string): Promise<TokenUsageWindows | null> {
  const row = await getPrismaClient()
    .accessToken.findUnique({ where: { id }, select: { plan: { select: PLAN_LIMITS_SELECT } } })
    .catch(() => null)
  if (row === null) return null
  const limits = row.plan === null ? null : planLimitsOf(row.plan)
  return {
    limited: limits !== null && hasAnyLimit(limits),
    windows: await readUsageWindows(id, limits)
  }
}

/**
 * Clear one token's usage windows, so its next request opens fresh ones.
 * Null when there is no such token.
 */
export async function resetTokenUsageWindows(id: string): Promise<TokenUsageWindows | null> {
  const exists = await getPrismaClient()
    .accessToken.findUnique({ where: { id }, select: { id: true } })
    .catch(() => null)
  if (exists === null) return null
  await resetUsageWindows(id)
  return getTokenUsageWindows(id)
}

/** Clear every token's usage windows. Returns how many window rows went. */
export function resetAllUsageWindows(): Promise<number> {
  return resetUsageWindows(null)
}
