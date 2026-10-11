/** Credential generation and the shared hot-path resolver cache. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { LRUCache } from 'lru-cache'
import { getPrismaClient } from '../db/client'
import { type PlanLimits, planLimitsOf } from './usage-window-service'

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
  /** Requests and USD allowed per 5-hour and 7-day window. Each null = no limit. */
  limits: PlanLimits
}

// The four window-limit columns of a plan, as the gate and the admin page read them.
export const PLAN_LIMITS_SELECT = {
  fiveHourRequestLimit: true,
  fiveHourSpendLimitUsd: true,
  sevenDayRequestLimit: true,
  sevenDaySpendLimitUsd: true
} as const

/**
 * A fresh secret and the two derived columns stored beside it.
 *
 * Shared by issue and rotate so a rotated token is indistinguishable
 * from a newly issued one — same entropy, same prefix rule. Anything
 * that made rotation cheaper than issuing would make rotation the weaker
 * credential, which is backwards.
 */
export function mintSecret(): { plaintext: string; tokenHash: string; prefix: string } {
  const plaintext = `${PREFIX}${randomBytes(TOKEN_BYTES).toString('hex')}`
  return {
    plaintext,
    tokenHash: sha256(plaintext),
    // Enough to tell two tokens apart in a list, not enough to use.
    prefix: plaintext.slice(0, PREFIX.length + 6)
  }
}

/**
 * Resolve a presented token, or null when it is unknown (including a
 * revoked one, whose row is gone) or expired. Fails closed: any error
 * resolving it is a rejection, never a pass.
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
        plan: {
          select: { models: true, defaultModel: true, ...PLAN_LIMITS_SELECT }
        }
      }
    })
    .catch(() => null)

  const usable =
    row !== null &&
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
                limits: planLimitsOf(row.plan)
              }
      }
    : null
  cache.set(hash, { row: resolved })
  return resolved
}
