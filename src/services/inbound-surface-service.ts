/**
 * Per-surface routing configuration.
 *
 * Reads `InboundSurfaceConfig` and joins it to the descriptors in
 * `llms/inbound/surfaces.ts`. Every surface has an explicit stored mode,
 * seeded at boot by `ensureInboundSurfaces`; there is no per-surface
 * default, so no value is more "the shipped one" than another.
 *
 * The router reads this on the hot path, so the resolved map is cached and
 * invalidated on write rather than re-queried per request.
 */

import { getPrismaClient } from '../db/client'
import {
  INBOUND_SURFACES,
  INITIAL_ROUTING_MODE,
  type InboundSurface,
  type RoutingMode,
  type SurfaceId,
  surfaceById,
  surfaceForPath
} from '../llms/inbound/surfaces'
import { DEFAULT_PROFILE_KEY, PASSTHROUGH_PROFILE_KEY } from './router-preference-service'

export interface ResolvedSurface extends InboundSurface {
  routingMode: RoutingMode
  /** RouterPreferenceProfile.key this surface's chain comes from. */
  profileKey: string
  /**
   * `provider,model` pairs a caller may not name here while this surface
   * is in passthrough. Empty is the normal state and means "anything the
   * providers serve", which is what passthrough did before this existed.
   */
  deniedTargets: string[]
}

// Resolved snapshot, rebuilt on write. `null` means "not loaded yet".
// Deliberately module-level: one process serves the router, and a stale
// read here would silently route a request the operator just re-pointed.
const cache: { value: ResolvedSurface[] | null } = { value: null }

export function invalidateSurfaceCache(): void {
  cache.value = null
}

/**
 * Seed the resolved cache directly, for tests that exercise the router
 * without a database.
 *
 * Named for what it is. Router behaviour depends on a surface's mode,
 * and a test that cannot set one is really asserting whatever the
 * fallback happens to be — which is how three tests came to depend on
 * `/v1/messages` defaulting to routed, and broke when that default was
 * removed rather than when the behaviour they described changed.
 */
export function __setSurfacesForTests(
  modes: Partial<Record<SurfaceId, RoutingMode>>,
  denied?: Partial<Record<SurfaceId, string[]>>
): void {
  cache.value = INBOUND_SURFACES.map((surface) => ({
    ...surface,
    routingMode: modes[surface.id] ?? INITIAL_ROUTING_MODE,
    profileKey: DEFAULT_PROFILE_KEY,
    deniedTargets: denied?.[surface.id] ?? []
  }))
}

const isRoutingMode = (v: string): v is RoutingMode => v === 'routed' || v === 'passthrough'

export async function listSurfaces(): Promise<ResolvedSurface[]> {
  const cached = cache.value
  if (cached !== null) return cached

  const rows = await getPrismaClient()
    .inboundSurfaceConfig.findMany()
    .catch(() => [])
  const byId = new Map(rows.map((r) => [r.surface, r]))

  const resolved = INBOUND_SURFACES.map((surface) => {
    const row = byId.get(surface.id)
    const stored = row !== undefined && isRoutingMode(row.routingMode) ? row.routingMode : undefined
    return {
      ...surface,
      // A surface added by a later version has no row until
      // `ensureInboundSurfaces` runs; the seed value stands in until it
      // does, so a read never has to invent a per-surface default.
      routingMode: stored !== undefined ? stored : INITIAL_ROUTING_MODE,
      profileKey: row?.profileKey !== undefined && row.profileKey !== null ? row.profileKey : DEFAULT_PROFILE_KEY,
      deniedTargets: row?.deniedTargets ?? []
    }
  })
  cache.value = resolved
  return resolved
}

/**
 * Give every registered surface a stored mode.
 *
 * Called once at boot, like `ensureRouterSlots`. Without it a surface's
 * mode would be half state and half fallback, which is what the old
 * `overridden` flag existed to explain — a value the operator could not
 * act on, describing a distinction that only mattered because the
 * fallback existed.
 *
 * Idempotent: an existing row is left exactly as it is.
 */
export async function ensureInboundSurfaces(): Promise<void> {
  const prisma = getPrismaClient()
  for (const surface of INBOUND_SURFACES) {
    await prisma.inboundSurfaceConfig
      .upsert({
        where: { surface: surface.id },
        create: { surface: surface.id, routingMode: INITIAL_ROUTING_MODE, profileKey: null },
        update: {}
      })
      .catch(() => {
        // A surface without a row still resolves to the seed value, so a
        // transient write failure degrades rather than blocking boot.
      })
  }
  invalidateSurfaceCache()
}

export async function resolveSurfaceForPath(path: string | undefined): Promise<ResolvedSurface | undefined> {
  // Path matching (exact vs glob) belongs to the descriptor registry —
  // this layer only adds the stored mode on top. The second copy that
  // used to live here carried its own hardcoded `/v1beta/models/` test,
  // which is precisely the kind of duplicate a fifth surface would have
  // had to remember to update.
  const descriptor = surfaceForPath(path)
  if (descriptor === undefined) return undefined
  const all = await listSurfaces()
  return all.find((s) => s.id === descriptor.id)
}

/**
 * Whether the full scenario → rule → preference-chain → failover pipeline
 * applies to this path.
 *
 * An unknown path is treated as routed: that is what `/v1/messages` (the
 * only path the old code did not name) did, and the caller only reaches
 * here from a mounted surface anyway.
 */
export async function isRoutedPath(path: string | undefined): Promise<boolean> {
  const surface = await resolveSurfaceForPath(path)
  if (surface === undefined) return true
  // The reserved key means the same thing wherever it appears, so a
  // surface pointed at it is passthrough even if its mode says routed.
  if (surface.profileKey === PASSTHROUGH_PROFILE_KEY) return false
  return surface.routingMode === 'routed'
}

export interface SurfaceUpdate {
  surface: SurfaceId
  routingMode: RoutingMode
  profileKey?: string | null
  /** Omitted leaves the stored list alone; an array replaces it wholesale. */
  deniedTargets?: string[]
}

export async function updateSurface(input: SurfaceUpdate): Promise<ResolvedSurface[]> {
  const descriptor = surfaceById(input.surface)
  if (descriptor === undefined) throw new Error(`Unknown inbound surface: ${input.surface}`)

  const profileKey = input.profileKey === undefined ? null : input.profileKey
  // `deniedTargets` is optional so the mode/profile writers — which have
  // no opinion on it — cannot blank the list by omitting it.
  const denied = input.deniedTargets
  await getPrismaClient().inboundSurfaceConfig.upsert({
    where: { surface: input.surface },
    create: {
      surface: input.surface,
      routingMode: input.routingMode,
      profileKey,
      deniedTargets: denied === undefined ? [] : denied
    },
    update:
      denied === undefined
        ? { routingMode: input.routingMode, profileKey }
        : { routingMode: input.routingMode, profileKey, deniedTargets: denied }
  })
  invalidateSurfaceCache()
  return listSurfaces()
}

/**
 * The reason to refuse this request, or undefined to let it through.
 *
 * Only passthrough surfaces have an answer. In routed mode the caller's
 * `body.model` is a hint the chain overrides, so there is nothing to
 * deny — denying it would reject a string that was never going to reach
 * an upstream.
 */
export async function passthroughDenial(
  path: string | undefined,
  target: string | undefined
): Promise<string | undefined> {
  if (target === undefined || target.length === 0) return undefined
  const surface = await resolveSurfaceForPath(path)
  if (surface === undefined) return undefined
  if (surface.routingMode !== 'passthrough') return undefined
  if (!surface.deniedTargets.includes(target)) return undefined
  return `${target} is turned off for ${surface.path}.`
}
