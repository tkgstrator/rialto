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

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { LRUCache } from 'lru-cache'
import { getPrismaClient } from '../db/client'
import dayjs from '../lib/dayjs'
import { spendByToken, type TokenWindowTotals } from './access-token-spend'

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
  revokedAt: string | null
  // When the current secret was minted, if it is not the original one.
  // Rotation preserves the row, so `createdAt` is the age of the client
  // binding and this is the age of the credential it presents.
  rotatedAt: string | null
  createdAt: string
}

export { SPEND_WINDOW_DAYS, sumSpendByToken, sumTokensByToken } from './access-token-spend'

export interface IssuedToken {
  token: AccessTokenRow
  /** Shown once. Never recoverable — reissue is the only path back. */
  plaintext: string
}

const PREFIX = 'rialto_'
const TOKEN_BYTES = 32
const CACHE_TTL_MS = 30_000

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

// Resolved tokens keyed by hash. `null` records "no such token", so a
// flood of bad credentials costs one query per distinct value rather
// than one per request.
const cache = new LRUCache<string, { row: ResolvedToken | null }>({ max: 500, ttl: CACHE_TTL_MS })

export function invalidateTokenCache(): void {
  cache.clear()
}

export interface ResolvedToken {
  id: string
  name: string
  /** Empty means the token is not pinned to any surface in particular. */
  surfaces: string[]
  profileKey: string | null
}

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
    revokedAt: Date | null
    rotatedAt: Date | null
    createdAt: Date
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
  revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
  rotatedAt: row.rotatedAt === null ? null : row.rotatedAt.toISOString(),
  createdAt: row.createdAt.toISOString()
})

export async function listAccessTokens(): Promise<AccessTokenRow[]> {
  const [rows, spend] = await Promise.all([
    getPrismaClient().accessToken.findMany({ orderBy: { createdAt: 'desc' } }),
    spendByToken()
  ])
  return rows.map((row) => toWire(row, spend.get(row.id)))
}

/** One token by id, priced the same way the list prices it. */
export async function getAccessToken(id: string): Promise<AccessTokenRow | null> {
  const row = await getPrismaClient()
    .accessToken.findUnique({ where: { id } })
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
}

/**
 * A fresh secret and the two derived columns stored beside it.
 *
 * Shared by issue and rotate so a rotated token is indistinguishable
 * from a newly issued one — same entropy, same prefix rule. Anything
 * that made rotation cheaper than issuing would make rotation the weaker
 * credential, which is backwards.
 */
function mintSecret(): { plaintext: string; tokenHash: string; prefix: string } {
  const plaintext = `${PREFIX}${randomBytes(TOKEN_BYTES).toString('hex')}`
  return {
    plaintext,
    tokenHash: sha256(plaintext),
    // Enough to tell two tokens apart in a list, not enough to use.
    prefix: plaintext.slice(0, PREFIX.length + 6)
  }
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
      expiresAt: input.expiresAt === undefined || input.expiresAt === null ? null : new Date(input.expiresAt)
    }
  })
  invalidateTokenCache()
  return { token: toWire(row), plaintext }
}

export interface UpdateInput {
  /** Replaces the scope wholesale. Empty means every surface. */
  surfaces?: string[]
  profileKey?: string | null
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
        ...(input.profileKey === undefined ? {} : { profileKey: input.profileKey })
      }
    })
    .catch(() => null)
  invalidateTokenCache()
  return row === null ? null : toWire(row)
}

/**
 * Why a rotation was refused. Rotation replaces the secret in place, so
 * the only sensible answers for a token that cannot authenticate anyway
 * are "no" and a reason — minting a new secret onto a revoked or expired
 * row would hand back a credential that is dead the moment it is copied.
 */
export type RotateRefusal = 'not-found' | 'revoked' | 'expired'

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
  if (existing.revokedAt !== null) return { ok: false, reason: 'revoked' }
  if (existing.expiresAt !== null && existing.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' }
  }

  const { plaintext, tokenHash, prefix } = mintSecret()
  const row = await getPrismaClient().accessToken.update({
    where: { id },
    data: { tokenHash, prefix, rotatedAt: dayjs().toDate() }
  })
  invalidateTokenCache()
  return { ok: true, issued: { token: toWire(row), plaintext } }
}

/**
 * Mark a token unusable without deleting it, so the RequestLog rows it
 * authenticated still point at something that says whose they were.
 */
export async function revokeAccessToken(id: string): Promise<AccessTokenRow | null> {
  const row = await getPrismaClient()
    .accessToken.update({ where: { id }, data: { revokedAt: new Date() } })
    .catch(() => null)
  invalidateTokenCache()
  return row === null ? null : toWire(row)
}

export async function deleteAccessToken(id: string): Promise<boolean> {
  const done = await getPrismaClient()
    .accessToken.delete({ where: { id } })
    .then(() => true)
    .catch(() => false)
  invalidateTokenCache()
  return done
}

/**
 * Resolve a presented token, or null when it is unknown, revoked or
 * expired. Fails closed: any error resolving it is a rejection, never a
 * pass.
 */
export async function resolveAccessToken(presented: string): Promise<ResolvedToken | null> {
  if (presented.length === 0) return null
  const hash = sha256(presented)

  const cached = cache.get(hash)
  if (cached !== undefined) return cached.row

  const row = await getPrismaClient()
    .accessToken.findUnique({ where: { tokenHash: hash } })
    .catch(() => null)

  const usable =
    row !== null &&
    row.revokedAt === null &&
    (row.expiresAt === null || row.expiresAt.getTime() > Date.now()) &&
    // Constant-time compare of the digests. findUnique already matched
    // on the hash, so this guards only against a storage-layer surprise
    // — cheap enough to keep.
    timingSafeEqual(Buffer.from(row.tokenHash, 'hex'), Buffer.from(hash, 'hex'))

  const resolved: ResolvedToken | null = usable
    ? { id: row.id, name: row.name, surfaces: row.surfaces, profileKey: row.profileKey }
    : null
  cache.set(hash, { row: resolved })
  return resolved
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
