/**
 * Routing configuration for the demo: provider tier aliases, the tier
 * maps, and the per-surface routing mode.
 *
 * The split between "demo-owned" and "only when unset" matters here. The
 * `cost-first` profile is keyed for the demo and rewritten on every run.
 * The tier aliases, the `live` map and the surface modes are the
 * operator's live configuration — the seed fills them in only while they
 * are still empty, so running it against a configured install cannot
 * silently re-point real traffic.
 */

import type { PrismaClient } from '../../src/generated/prisma/client'
import type {
  ModelTier,
  RoutingLane,
  RoutingScenario,
  ScenarioRoutes,
  TierRoute
} from '../../src/schemas/domain/tier-route'
import { saveTierProfile } from '../../src/services/tier-route-service'
import { DEMO_PROFILE_KEY } from './demo-rows'
import type { DemoTarget } from './targets'

const MODEL_TIERS: readonly ModelTier[] = ['fable', 'opus', 'sonnet', 'haiku']

// Which model stands in for each tier on a provider whose model names say
// no Claude family. Written against the catalog this repo ships with; a
// provider none of them match simply gets no alias for that tier.
const STAND_INS: Record<ModelTier, RegExp> = {
  fable: /fable|astra/,
  opus: /opus|-sol$/,
  sonnet: /sonnet|terra|flash(?!-lite)/,
  haiku: /haiku|luna|flash-lite/
}

// Unpriced (subscription) models sort last rather than free: "no price"
// is not the same statement as "cheapest", and a cost-first map that led
// with them would be misleading.
const costOf = (target: DemoTarget): number =>
  target.inputPer1M === null ? Number.MAX_SAFE_INTEGER : target.inputPer1M

/** provider name → tier → the model its alias points at. */
export type AliasMap = Map<string, Map<ModelTier, DemoTarget>>

// The last match in catalog order, which for names like claude-opus-4-7 /
// claude-opus-5 is the newer generation.
const standInFor = (models: DemoTarget[], tier: ModelTier): DemoTarget | undefined =>
  [...models].reverse().find((t) => (t.tier === null ? STAND_INS[tier].test(t.modelName.toLowerCase()) : t.tier === tier))

function planAliases(targets: DemoTarget[]): AliasMap {
  const byProvider = new Map<string, DemoTarget[]>()
  for (const target of targets) {
    const list = byProvider.get(target.providerName)
    byProvider.set(target.providerName, list === undefined ? [target] : [...list, target])
  }
  const plan: AliasMap = new Map()
  for (const [provider, models] of byProvider) {
    const tiers = new Map<ModelTier, DemoTarget>()
    for (const tier of MODEL_TIERS) {
      const model = standInFor(models, tier)
      if (model !== undefined) tiers.set(tier, model)
    }
    plan.set(provider, tiers)
  }
  return plan
}

// Write the planned aliases a provider does not have yet, then read back
// what is actually set: an alias the operator chose wins over the plan.
async function seedAliases(prisma: PrismaClient, targets: DemoTarget[]): Promise<{ aliases: AliasMap; written: number }> {
  const providers = await prisma.provider.findMany({ select: { id: true, name: true } })
  const providerId = new Map(providers.map((p) => [p.name, p.id]))
  const existing = await prisma.providerTierAlias.findMany({ select: { providerId: true, tier: true } })
  const taken = new Set(existing.map((a) => `${a.providerId}|${a.tier}`))
  const rows = [...planAliases(targets)].flatMap(([provider, tiers]) => {
    const id = providerId.get(provider)
    if (id === undefined) return []
    return [...tiers]
      .filter(([tier]) => !taken.has(`${id}|${tier}`))
      .map(([tier, model]) => ({ providerId: id, tier, modelId: model.modelId }))
  })
  if (rows.length > 0) await prisma.providerTierAlias.createMany({ data: rows, skipDuplicates: true })

  const byModelId = new Map(targets.map((t) => [t.modelId, t]))
  const stored = await prisma.providerTierAlias.findMany({
    select: { tier: true, modelId: true, provider: { select: { name: true } } }
  })
  const aliases: AliasMap = new Map()
  for (const row of stored) {
    const model = byModelId.get(row.modelId)
    const tier = MODEL_TIERS.find((t) => t === row.tier)
    // An alias on a switched-off model resolves to nothing at request
    // time either, so the demo routes do not lean on it.
    if (model === undefined || tier === undefined) continue
    const tiers = aliases.get(row.provider.name)
    if (tiers === undefined) aliases.set(row.provider.name, new Map([[tier, model]]))
    else tiers.set(tier, model)
  }
  return { aliases, written: rows.length }
}

// The tiers each list asks for, most wanted first — the shape a Claude
// plan install typically has: Sonnet for ordinary work, Opus when thinking,
// Fable for long input, and the smaller model first for subagents.
const LIST_TIERS: Record<RoutingScenario, Record<RoutingLane, ModelTier[]>> = {
  default: { agent: ['sonnet', 'haiku'], subagent: ['haiku', 'sonnet'] },
  think: { agent: ['opus', 'sonnet'], subagent: ['sonnet'] },
  longContext: { agent: ['fable', 'opus'], subagent: [] }
}

// For each list, each wanted tier from the first provider in `order` that
// has it. The default agent list's second route is switched off, so the
// screen shows the toggle in its non-default state.
function buildRoutes(aliases: AliasMap, order: (tier: ModelTier) => string[]): ScenarioRoutes {
  const routesFor = (scenario: RoutingScenario, lane: RoutingLane): TierRoute[] =>
    LIST_TIERS[scenario][lane].flatMap((tier, i) => {
      const provider = order(tier).find((p) => aliases.get(p)?.has(tier) === true)
      const off = scenario === 'default' && lane === 'agent' && i === 1
      return provider === undefined ? [] : [{ provider, targetTier: tier, enabled: !off }]
    })
  const lanes = (scenario: RoutingScenario) => ({ agent: routesFor(scenario, 'agent'), subagent: routesFor(scenario, 'subagent') })
  return { default: lanes('default'), think: lanes('think'), longContext: lanes('longContext') }
}

/** What each list resolves to, first route first — what the traffic seed samples from. */
export type ResolvedRoutes = Record<RoutingScenario, Record<RoutingLane, DemoTarget[]>>

const resolve = (routes: ScenarioRoutes, aliases: AliasMap): ResolvedRoutes => {
  const targetsOf = (list: TierRoute[]): DemoTarget[] =>
    list.flatMap((r) => {
      const model = r.enabled ? aliases.get(r.provider)?.get(r.targetTier) : undefined
      return model === undefined ? [] : [model]
    })
  const lanes = (scenario: RoutingScenario) => ({
    agent: targetsOf(routes[scenario].agent),
    subagent: targetsOf(routes[scenario].subagent)
  })
  return { default: lanes('default'), think: lanes('think'), longContext: lanes('longContext') }
}

export interface TierMapReport {
  aliasesWritten: number
  live: 'written' | 'skipped'
  demoProfile: string
  warnings: string[]
  // Per profile key, for the traffic seed.
  resolved: Record<string, ResolvedRoutes>
}

const DEFAULT_CONSTRAINTS = {
  exhaustedBehavior: '429',
  quotaSkipPct: 100,
  errorRateSkipPct: 0.5,
  minHealthSamples: 5,
  longContextThreshold: null,
  previousLongContextThreshold: null,
  longContextTunedAt: null,
  autoTuneLongContext: true
} as const

/**
 * Seed the aliases and the `live` map (only while unset) and always
 * (re)create the demo `cost-first` profile, which gives the profile
 * picker on the Routing screen a second option to switch between.
 */
export async function seedTierMap(prisma: PrismaClient, targets: DemoTarget[]): Promise<TierMapReport> {
  const { aliases, written } = await seedAliases(prisma, targets)
  const subscriptions = new Set(targets.filter((t) => t.subscription).map((t) => t.providerName))
  const providers = [...aliases.keys()]
  const warnings: string[] = []

  // Subscriptions first — what an install with a Claude plan leads with.
  const bySubscription = [...providers].sort(
    (a, b) => Number(subscriptions.has(b)) - Number(subscriptions.has(a)) || a.localeCompare(b)
  )
  const liveRoutes = buildRoutes(aliases, () => bySubscription)
  const liveRouteCount = await prisma.tierRoute.count({ where: { profile: { key: 'live' } } })
  const liveIsEmpty = liveRouteCount === 0
  if (liveIsEmpty) {
    const outcome = await saveTierProfile('live', { routes: liveRoutes, constraints: DEFAULT_CONSTRAINTS }, prisma)
    warnings.push(...outcome.warnings)
  }

  // Cheapest provider first for each tier.
  const cheapestFirst = (tier: ModelTier): string[] =>
    [...providers].sort((a, b) => {
      const ma = aliases.get(a)?.get(tier)
      const mb = aliases.get(b)?.get(tier)
      return (ma === undefined ? Number.MAX_SAFE_INTEGER : costOf(ma)) - (mb === undefined ? Number.MAX_SAFE_INTEGER : costOf(mb))
    })
  const costRoutes = buildRoutes(aliases, cheapestFirst)
  const outcome = await saveTierProfile(
    DEMO_PROFILE_KEY,
    { routes: costRoutes, constraints: { ...DEFAULT_CONSTRAINTS, quotaSkipPct: 90, exhaustedBehavior: 'passthrough' } },
    prisma
  )
  warnings.push(...outcome.warnings)

  return {
    aliasesWritten: written,
    live: liveIsEmpty ? 'written' : 'skipped',
    demoProfile: DEMO_PROFILE_KEY,
    warnings,
    resolved: { live: resolve(liveRoutes, aliases), [DEMO_PROFILE_KEY]: resolve(costRoutes, aliases) }
  }
}

export interface SurfaceReport {
  updated: string[]
  skipped: string[]
}

// Which surface gets which mode. Anthropic traffic routes through the
// live map; the OpenAI chat surface demonstrates a per-surface profile
// override; the remaining two stay in passthrough so both states are on
// screen at once.
const SURFACE_MODES: Array<{ surface: string; routingMode: string; profileKey: string | null }> = [
  { surface: 'anthropic-messages', routingMode: 'routed', profileKey: null },
  { surface: 'openai-chat', routingMode: 'routed', profileKey: DEMO_PROFILE_KEY }
]

/**
 * Point two of the four surfaces at a map — but only while they still
 * carry the seeded passthrough default, since flipping a surface the
 * operator deliberately configured would change what their gateway does.
 */
export async function seedSurfaceModes(prisma: PrismaClient): Promise<SurfaceReport> {
  const report: SurfaceReport = { updated: [], skipped: [] }
  for (const entry of SURFACE_MODES) {
    const existing = await prisma.inboundSurfaceConfig.findUnique({ where: { surface: entry.surface } })
    if (existing !== null && (existing.routingMode !== 'passthrough' || existing.profileKey !== null)) {
      report.skipped.push(entry.surface)
      continue
    }
    await prisma.inboundSurfaceConfig.upsert({
      where: { surface: entry.surface },
      update: { routingMode: entry.routingMode, profileKey: entry.profileKey },
      create: { surface: entry.surface, routingMode: entry.routingMode, profileKey: entry.profileKey }
    })
    report.updated.push(entry.surface)
  }
  return report
}
