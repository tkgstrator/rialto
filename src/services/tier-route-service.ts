/**
 * The tier map, stored: one profile's routes per requested tier, and the
 * constraints that go with them.
 *
 * Profiles are the same `RouterPreferenceProfile` rows the chain used —
 * a surface's `profileKey` and an access token's `profileKey` keep
 * pointing at them — and the constraints live in the same JSONB column.
 * Until the request path switches over, the old chain reads that column
 * too, so a save here merges its four knobs into the blob rather than
 * replacing it: replacing would reset every knob this map does not carry
 * to its default under the router that is still running.
 */

import { getPrismaClient } from '../db/client'
import type { Prisma, PrismaClient } from '../generated/prisma/client'
import { logger } from '../logger'
import { JsonObjectSchema } from '../schemas/domain/preset'
import {
  ROUTE_TIERS,
  type RouteTier,
  type RoutingConstraints,
  RoutingConstraintsSchema,
  type TierProfile,
  type TierRoute,
  TierRoutesSchema
} from '../schemas/domain/tier-route'
import { hostsWebSearch } from '../shared/transformer-chain'
import { DEFAULT_PROFILE_KEY, PASSTHROUGH_PROFILE_KEY } from './router-preference-service'
import { aliasKey, resolveTierAliases } from './tier-alias-service'

const emptyRoutes = (): Record<RouteTier, TierRoute[]> => ({ fable: [], opus: [], sonnet: [], haiku: [], other: [] })

// The constraints a blob describes, every knob defaulted. A blob that
// fails to parse (hand-edited JSONB) reads as the defaults rather than
// taking routing down, the same as the chain did.
export const routingConstraintsOf = (blob: Prisma.JsonValue | null): RoutingConstraints => {
  const parsed = RoutingConstraintsSchema.safeParse(blob === null ? {} : blob)
  if (parsed.success) return parsed.data
  const defaults = RoutingConstraintsSchema.safeParse({})
  // Every knob has a default, so an empty object cannot fail; if one ever
  // loses its default this says so at the first read.
  if (!defaults.success) throw new Error('RoutingConstraintsSchema has a knob without a default')
  return defaults.data
}

/** One profile's map, routes in priority order. A profile with no row reads as empty. */
export async function loadTierProfile(
  profileKey: string = DEFAULT_PROFILE_KEY,
  prisma: PrismaClient = getPrismaClient()
): Promise<TierProfile> {
  const profile = await prisma.routerPreferenceProfile.findUnique({
    where: { key: profileKey },
    select: {
      constraints: true,
      tierRoutes: {
        orderBy: { priority: 'asc' },
        select: { requestedTier: true, targetTier: true, enabled: true, provider: { select: { name: true } } }
      }
    }
  })
  if (profile === null) return { routes: emptyRoutes(), constraints: routingConstraintsOf(null) }
  const grouped: Record<string, unknown[]> = {}
  for (const row of profile.tierRoutes) {
    const list = grouped[row.requestedTier]
    const route = { provider: row.provider.name, targetTier: row.targetTier, enabled: row.enabled }
    grouped[row.requestedTier] = list === undefined ? [route] : [...list, route]
  }
  // Parsed rather than trusted: a tier string an older or newer build
  // wrote is dropped here instead of reaching a reader that switches on it.
  const routes = TierRoutesSchema.safeParse(grouped)
  if (!routes.success) {
    logger.warn(
      { profileKey, err: routes.error.message },
      '[tier-routes] stored routes did not parse; reading as empty'
    )
  }
  return {
    routes: routes.success ? routes.data : emptyRoutes(),
    constraints: routingConstraintsOf(profile.constraints)
  }
}

export interface SaveOutcome {
  success: boolean
  warnings: string[]
}

/**
 * Replace one profile's map and set its constraints.
 *
 * Whole-profile replacement in one transaction, so no reader sees half a
 * map. A route naming a provider that does not exist is dropped with a
 * warning; a duplicate within a tier (the same provider's same tier twice)
 * keeps its first position. A route whose alias is unset is kept and
 * warned about — it is a gap the operator can close on the provider's
 * page, and refusing the save would lose the rest of the edit.
 */
export async function saveTierProfile(
  profileKey: string,
  profile: TierProfile,
  prisma: PrismaClient = getPrismaClient()
): Promise<SaveOutcome> {
  // The reserved key skips routing, so a map stored under it could never
  // run, and an editor showing it would be showing something ignored.
  if (profileKey === PASSTHROUGH_PROFILE_KEY) {
    return {
      success: false,
      warnings: [`"${PASSTHROUGH_PROFILE_KEY}" is a reserved profile that skips routing; it cannot hold routes.`]
    }
  }
  const warnings: string[] = []
  const providers = await prisma.provider.findMany({ select: { id: true, name: true } })
  const providerId = new Map(providers.map((p) => [p.name, p.id]))
  const aliases = await resolveTierAliases(prisma)

  const rows: Array<Omit<Prisma.TierRouteCreateManyInput, 'profileId'>> = []
  for (const requestedTier of ROUTE_TIERS) {
    const seen = new Set<string>()
    for (const route of profile.routes[requestedTier]) {
      const id = providerId.get(route.provider)
      if (id === undefined) {
        warnings.push(`${requestedTier}: provider "${route.provider}" does not exist; route dropped`)
        continue
      }
      const key = aliasKey(route.provider, route.targetTier)
      if (seen.has(key)) {
        warnings.push(`${requestedTier}: ${route.provider} · ${route.targetTier} is listed twice; kept the first`)
        continue
      }
      seen.add(key)
      if (!aliases.has(key)) {
        warnings.push(
          `${requestedTier}: ${route.provider} has no ${route.targetTier} alias yet; the route is skipped until one is set`
        )
      }
      rows.push({
        requestedTier,
        priority: seen.size,
        providerId: id,
        targetTier: route.targetTier,
        enabled: route.enabled
      })
    }
  }

  await prisma.$transaction(async (tx) => {
    const existing = await tx.routerPreferenceProfile.findUnique({
      where: { key: profileKey },
      select: { constraints: true }
    })
    const base = JsonObjectSchema.safeParse(existing === null ? {} : existing.constraints)
    const constraints = { ...(base.success ? base.data : {}), ...profile.constraints }
    const row = await tx.routerPreferenceProfile.upsert({
      where: { key: profileKey },
      update: { constraints },
      create: { key: profileKey, constraints }
    })
    await tx.tierRoute.deleteMany({ where: { profileId: row.id } })
    if (rows.length > 0) await tx.tierRoute.createMany({ data: rows.map((r) => ({ ...r, profileId: row.id })) })
  })

  if (warnings.length > 0) logger.warn({ profileKey, warnings }, '[tier-routes] save completed with warnings')
  return { success: true, warnings }
}

export interface TierProfileSummary {
  key: string
  routeCount: number
  updatedAt: string | null
  // The reserved passthrough key is listed so a picker can offer it, and
  // flagged so it is not mistaken for a map.
  kind: 'map' | 'passthrough'
}

/** Every profile a surface or token can point at, the default first even before it has a row. */
export async function listTierProfiles(prisma: PrismaClient = getPrismaClient()): Promise<TierProfileSummary[]> {
  const rows = await prisma.routerPreferenceProfile.findMany({
    orderBy: { key: 'asc' },
    select: { key: true, updatedAt: true, _count: { select: { tierRoutes: true } } }
  })
  const listed = rows
    .filter((r) => r.key !== PASSTHROUGH_PROFILE_KEY)
    .map((r) => ({
      key: r.key,
      routeCount: r._count.tierRoutes,
      updatedAt: r.updatedAt.toISOString(),
      kind: 'map' as const
    }))
  const withDefault = listed.some((p) => p.key === DEFAULT_PROFILE_KEY)
    ? listed
    : [{ key: DEFAULT_PROFILE_KEY, routeCount: 0, updatedAt: null, kind: 'map' as const }, ...listed]
  return [
    ...withDefault,
    { key: PASSTHROUGH_PROFILE_KEY, routeCount: 0, updatedAt: null, kind: 'passthrough' as const }
  ]
}

export interface TierRouteResolution {
  model: string
  targetEnabled: boolean
  hostsWebSearch: boolean
  contextWindow: number | null
}

export interface TierRouteView extends TierRoute {
  resolved: TierRouteResolution | null
}

export interface TierProfileView {
  key: string
  routes: Record<RouteTier, TierRouteView[]>
  constraints: RoutingConstraints
}

/**
 * One profile's map with each route resolved through its alias: the model
 * it reaches today, whether that model can take traffic, whether it can
 * run the web_search tool, and its context window. What the Routing
 * screen draws, read in one pass instead of one request per row.
 */
export async function loadTierProfileView(
  profileKey: string = DEFAULT_PROFILE_KEY,
  prisma: PrismaClient = getPrismaClient()
): Promise<TierProfileView> {
  const [profile, aliasRows] = await Promise.all([
    loadTierProfile(profileKey, prisma),
    prisma.providerTierAlias.findMany({
      select: {
        tier: true,
        provider: { select: { name: true, apiBaseUrl: true, authMode: true, apiStyle: true, enabled: true } },
        model: { select: { name: true, enabled: true, apiStyle: true, contextWindow: true } }
      }
    })
  ])
  const resolution = new Map<string, TierRouteResolution>(
    aliasRows.map((a) => [
      `${a.provider.name}|${a.tier}`,
      {
        model: a.model.name,
        targetEnabled: a.model.enabled && a.provider.enabled,
        hostsWebSearch: hostsWebSearch(
          {
            name: a.provider.name,
            api_base_url: a.provider.apiBaseUrl,
            auth_mode: a.provider.authMode,
            api_style: a.provider.apiStyle
          },
          a.model.apiStyle === null ? undefined : a.model.apiStyle
        ),
        contextWindow: a.model.contextWindow
      }
    ])
  )
  const view = (routes: TierRoute[]): TierRouteView[] =>
    routes.map((route) => {
      const resolved = resolution.get(`${route.provider}|${route.targetTier}`)
      return { ...route, resolved: resolved === undefined ? null : resolved }
    })
  return {
    key: profileKey,
    routes: {
      fable: view(profile.routes.fable),
      opus: view(profile.routes.opus),
      sonnet: view(profile.routes.sonnet),
      haiku: view(profile.routes.haiku),
      other: view(profile.routes.other)
    },
    constraints: profile.constraints
  }
}
