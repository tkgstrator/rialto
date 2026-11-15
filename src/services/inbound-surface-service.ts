/**
 * Per-surface configuration.
 *
 * Reads `InboundSurfaceConfig` and joins it to the descriptors in
 * `llms/inbound/surfaces.ts`. A row holds only the targets an operator has
 * turned off for that surface; a surface with no row has none turned off,
 * which is what every surface did before the list existed.
 *
 * The request path reads this on every call, so the resolved map is cached
 * and invalidated on write rather than re-queried per request.
 */

import { getPrismaClient } from '../db/client'
import {
  INBOUND_SURFACES,
  type InboundSurface,
  type SurfaceId,
  surfaceById,
  surfaceForPath
} from '../llms/inbound/surfaces'

export interface ResolvedSurface extends InboundSurface {
  /**
   * `provider,model` pairs a caller may not name here. Empty is the normal
   * state and means "anything the providers serve".
   */
  deniedTargets: string[]
}

// Resolved snapshot, rebuilt on write. `null` means "not loaded yet".
// Deliberately module-level: one process serves the request path, and a
// stale read here would silently let through a target the operator just
// turned off.
const cache: { value: ResolvedSurface[] | null } = { value: null }

export function invalidateSurfaceCache(): void {
  cache.value = null
}

/**
 * Seed the resolved cache directly, for tests that exercise the request
 * path without a database.
 *
 * Named for what it is: a test that cannot set the denied list is really
 * asserting whatever the fallback happens to be.
 */
export function __setSurfacesForTests(denied?: Partial<Record<SurfaceId, string[]>>): void {
  cache.value = INBOUND_SURFACES.map((surface) => ({
    ...surface,
    deniedTargets: denied?.[surface.id] ?? []
  }))
}

export async function listSurfaces(): Promise<ResolvedSurface[]> {
  const cached = cache.value
  if (cached !== null) return cached

  const rows = await getPrismaClient()
    .inboundSurfaceConfig.findMany()
    .catch(() => [])
  const byId = new Map(rows.map((r) => [r.surface, r]))

  const resolved = INBOUND_SURFACES.map((surface) => ({
    ...surface,
    deniedTargets: byId.get(surface.id)?.deniedTargets ?? []
  }))
  cache.value = resolved
  return resolved
}

export async function resolveSurfaceForPath(path: string | undefined): Promise<ResolvedSurface | undefined> {
  // Path matching (exact vs glob) belongs to the descriptor registry —
  // this layer only adds the stored denied list on top.
  const descriptor = surfaceForPath(path)
  if (descriptor === undefined) return undefined
  const all = await listSurfaces()
  return all.find((s) => s.id === descriptor.id)
}

export interface SurfaceUpdate {
  surface: SurfaceId
  deniedTargets: string[]
}

export async function updateSurface(input: SurfaceUpdate): Promise<ResolvedSurface[]> {
  const descriptor = surfaceById(input.surface)
  if (descriptor === undefined) throw new Error(`Unknown inbound surface: ${input.surface}`)

  await getPrismaClient().inboundSurfaceConfig.upsert({
    where: { surface: input.surface },
    create: { surface: input.surface, deniedTargets: input.deniedTargets },
    update: { deniedTargets: input.deniedTargets }
  })
  invalidateSurfaceCache()
  return listSurfaces()
}

/**
 * The reason to refuse this request, or undefined to let it through.
 */
export async function passthroughDenial(
  path: string | undefined,
  target: string | undefined
): Promise<string | undefined> {
  if (target === undefined || target.length === 0) return undefined
  const surface = await resolveSurfaceForPath(path)
  if (surface === undefined) return undefined
  if (!surface.deniedTargets.includes(target)) return undefined
  return `${target} is turned off for ${surface.path}.`
}
