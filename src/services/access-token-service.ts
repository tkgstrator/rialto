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
  /** The plan this token spends under. Null = unrestricted. */
  plan: { id: string; name: string } | null
  /** The authorized app whose install minted this token, if one did. */
  app: { id: string; name: string } | null
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
  /** What this token may spend, read from its plan. Null = unrestricted. */
  plan: TokenPlan | null
}

export interface TokenPlan {
  /** `provider,model` ids a request may name. */
  models: string[]
  /** Where a request naming anything else, or nothing, is sent. */
  defaultModel: string
  /** Completion requests allowed per UTC day. Null = no cap. */
  dailyRequestLimit: number | null
}

// The relations every wire row carries: which plan, and which app minted it.
const WIRE_INCLUDE = {
  plan: { select: { id: true, name: true } },
  device: { select: { authorizedApp: { select: { id: true, name: true } } } }
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
    revokedAt: Date | null
    rotatedAt: Date | null
    createdAt: Date
    plan?: { id: string; name: string } | null
    device?: { authorizedApp: { id: string; name: string } } | null
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
  createdAt: row.createdAt.toISOString(),
  plan: row.plan === undefined || row.plan === null ? null : { id: row.plan.id, name: row.plan.name },
  app:
    row.device === undefined || row.device === null
      ? null
      : { id: row.device.authorizedApp.id, name: row.device.authorizedApp.name }
})

/**
 * Every token, or with `manualOnly` just the hand-issued ones.
 *
 * The Tokens tab asks for the hand-issued ones: tokens an app install
 * minted for itself are listed per app instead (authorized-app-service) —
 * there can be thousands, and mixed in they would bury the dozen an
 * operator looks after. Activity still reads them all, because its spend
 * shares have to add up to what the window actually cost.
 */
export async function listAccessTokens({
  manualOnly = false
}: {
  manualOnly?: boolean
} = {}): Promise<AccessTokenRow[]> {
  const [rows, spend] = await Promise.all([
    getPrismaClient().accessToken.findMany({
      ...(manualOnly ? { where: { device: { is: null } } } : {}),
      orderBy: { createdAt: 'desc' },
      include: WIRE_INCLUDE
    }),
    spendByToken()
  ])
  return rows.map((row) => toWire(row, spend.get(row.id)))
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
    data: { tokenHash, prefix, rotatedAt: dayjs().toDate() },
    include: WIRE_INCLUDE
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
    .accessToken.update({ where: { id }, data: { revokedAt: new Date() }, include: WIRE_INCLUDE })
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
    .accessToken.findUnique({
      where: { tokenHash: hash },
      include: {
        plan: { select: { models: true, defaultModel: true, dailyRequestLimit: true } },
        device: { select: { authorizedApp: { select: { enabled: true } } } }
      }
    })
    .catch(() => null)

  const usable =
    row !== null &&
    row.revokedAt === null &&
    // An app switched off takes every token its installs minted with it.
    (row.device === null || row.device.authorizedApp.enabled) &&
    (row.expiresAt === null || row.expiresAt.getTime() > Date.now()) &&
    // Constant-time compare of the digests. findUnique already matched
    // on the hash, so this guards only against a storage-layer surprise
    // — cheap enough to keep.
    timingSafeEqual(Buffer.from(row.tokenHash, 'hex'), Buffer.from(hash, 'hex'))

  const resolved: ResolvedToken | null = usable
    ? {
        id: row.id,
        name: row.name,
        surfaces: row.surfaces,
        profileKey: row.profileKey,
        plan:
          row.plan === null
            ? null
            : {
                models: row.plan.models,
                defaultModel: row.plan.defaultModel,
                dailyRequestLimit: row.plan.dailyRequestLimit
              }
      }
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

export type DailyAllowance =
  | { outcome: 'allowed' }
  | { outcome: 'exhausted'; retryAfterSeconds: number }
  | { outcome: 'unavailable' }

/**
 * Count one request against a token's daily cap and say whether it may
 * proceed.
 *
 * Increment-then-compare in a single upsert, so two concurrent requests
 * cannot both read "one left" and both go through. The request that
 * crosses the cap is refused and still counted, which is harmless: the
 * count only ever decides refusals for the rest of that day.
 *
 * A failed write refuses rather than admits ('unavailable'): the cap is
 * the only thing bounding what a free token can spend, so an outage of
 * the ledger must not turn into an outage of the cap.
 */
export async function consumeDailyRequest(tokenId: string, limit: number): Promise<DailyAllowance> {
  // UTC, so every instance agrees on where a day ends whatever TZ it runs in.
  const now = dayjs().toDate()
  const day = now.toISOString().slice(0, 10)
  const row = await getPrismaClient()
    .accessTokenDailyUsage.upsert({
      where: { accessTokenId_day: { accessTokenId: tokenId, day } },
      create: { accessTokenId: tokenId, day, requests: 1 },
      update: { requests: { increment: 1 } }
    })
    .catch(() => null)
  if (row === null) return { outcome: 'unavailable' }
  if (row.requests <= limit) return { outcome: 'allowed' }
  const nextUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  const retryAfterSeconds = Math.max(1, Math.ceil((nextUtcMidnight - now.getTime()) / 1000))
  return { outcome: 'exhausted', retryAfterSeconds }
}
