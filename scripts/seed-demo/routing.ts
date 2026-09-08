/**
 * Routing configuration for the demo: slots, preference chains, saved
 * presets, scheduler weight history, and the per-surface routing mode.
 *
 * The split between "demo-owned" and "only when unset" matters here.
 * Presets and weight changes carry `demo-` ids and are replaced on every
 * run. RouterSlot rows, the `live` preference chain and the surface modes
 * are the operator's live configuration — the seed fills them in only
 * while they are still empty, so running it against a configured install
 * cannot silently re-point real traffic.
 */

import type { PrismaClient } from '../../src/generated/prisma/client'
import { applyRouterPreferences } from '../../src/services/router-preference-service'
import { DEMO_PROFILE_KEY, demoId } from './demo-rows'
import type { Random } from './random'
import { type DemoTarget, pickChain } from './targets'

type ScenarioKey = 'default' | 'think' | 'longContext' | 'webSearch' | 'image'

const SCENARIOS: readonly ScenarioKey[] = ['default', 'think', 'longContext', 'webSearch', 'image']

// Object types rather than interfaces: Prisma's JSON input accepts a
// mapped index signature, which an interface does not satisfy implicitly.
type RuleWhen = { requestedModel?: string; effort?: string[]; requestedTier?: string[]; thinking?: boolean }
type RuleJson = { name: string; when: RuleWhen; target: string }
type RouteJson = { primary: string | null; fallbacks: string[]; rules: RuleJson[] }
type SlotParams = {
  fallbacks: string[]
  subagentFallbacks: string[]
  agentRules: RuleJson[]
  subagentRules: RuleJson[]
  threshold?: number
}

// Model-name fragments, most preferred first, per scenario and lane.
// Fragments rather than exact ids because the database may hold a
// different generation of the same families; pickChain() skips the ones
// that match nothing and pads from the catalog.
const CHAIN_PREFERENCES: Record<ScenarioKey, { agent: string[]; subagent: string[] }> = {
  default: { agent: ['sonnet', 'terra', 'flash'], subagent: ['haiku', 'luna', 'flash-lite'] },
  think: { agent: ['opus', 'fable', 'sol'], subagent: ['sonnet', 'terra'] },
  longContext: { agent: ['fable', 'terra', 'flash'], subagent: ['sonnet', 'luna'] },
  webSearch: { agent: ['flash', 'sonnet', 'terra'], subagent: ['flash-lite', 'haiku'] },
  image: { agent: ['flash', 'sonnet'], subagent: ['flash-lite', 'haiku'] }
}

// Manual longContext threshold, so the Routing screen shows a configured
// value instead of only the auto-derived one.
const LONG_CONTEXT_THRESHOLD = 200_000

// Unpriced (subscription) models sort last rather than free: "no price"
// is not the same statement as "cheapest", and a cost-first chain that
// led with them would be misleading.
const costOf = (target: DemoTarget): number =>
  target.inputPer1M === null ? Number.MAX_SAFE_INTEGER : target.inputPer1M

const refsOf = (chain: DemoTarget[]): string[] => chain.map((t) => t.ref)

export type ChainsByScenario = Record<ScenarioKey, { agent: DemoTarget[]; subagent: DemoTarget[] }>

export function buildChains(targets: DemoTarget[]): ChainsByScenario {
  const chainFor = (scenario: ScenarioKey) => ({
    agent: pickChain(targets, CHAIN_PREFERENCES[scenario].agent, 3),
    subagent: pickChain(targets, CHAIN_PREFERENCES[scenario].subagent, 2)
  })
  return {
    default: chainFor('default'),
    think: chainFor('think'),
    longContext: chainFor('longContext'),
    webSearch: chainFor('webSearch'),
    image: chainFor('image')
  }
}

// Two rules that exercise the rule editor: the haiku predicate that
// replaced the deleted `background` scenario, and an effort-based
// escalation on `think`.
function rulesFor(scenario: ScenarioKey, chains: ChainsByScenario): RuleJson[] {
  if (scenario === 'default') {
    const cheap = chains.default.subagent[0]
    if (cheap === undefined) return []
    return [{ name: 'background traffic', when: { requestedModel: '*haiku*' }, target: cheap.ref }]
  }
  if (scenario === 'think') {
    const top = chains.think.agent[0]
    if (top === undefined) return []
    return [{ name: 'heavy effort', when: { effort: ['xhigh', 'max'] }, target: top.ref }]
  }
  return []
}

export interface SlotReport {
  written: ScenarioKey[]
  skipped: ScenarioKey[]
}

/**
 * Bind every scenario's agent and subagent lanes.
 *
 * A slot that already points somewhere is left untouched — the operator
 * configured it, and the demo has no business overwriting live routing.
 */
export async function seedRouterSlots(prisma: PrismaClient, chains: ChainsByScenario): Promise<SlotReport> {
  const report: SlotReport = { written: [], skipped: [] }
  for (const scenario of SCENARIOS) {
    const agent = chains[scenario].agent
    const subagent = chains[scenario].subagent
    if (agent.length === 0) continue
    const existing = await prisma.routerSlot.findUnique({ where: { scenario } })
    if (existing !== null && (existing.modelId !== null || existing.subagentModelId !== null)) {
      report.skipped.push(scenario)
      continue
    }
    const params: SlotParams = {
      fallbacks: refsOf(agent.slice(1)),
      subagentFallbacks: refsOf(subagent.slice(1)),
      agentRules: rulesFor(scenario, chains),
      subagentRules: [],
      ...(scenario === 'longContext' ? { threshold: LONG_CONTEXT_THRESHOLD } : {})
    }
    const data = {
      modelId: agent[0].modelId,
      subagentModelId: subagent.length > 0 ? subagent[0].modelId : null,
      params
    }
    await prisma.routerSlot.upsert({ where: { scenario }, update: data, create: { scenario, ...data } })
    report.written.push(scenario)
  }
  return report
}

// `disableTail` leaves one chain with a soft-disabled last entry, so the
// per-entry toggle has a non-default state somewhere on screen without
// every chain looking systematically clipped.
const entriesFor = (
  chain: DemoTarget[],
  disableTail: boolean
): Array<{ priority: number; target: string; enabled: boolean }> =>
  chain.map((target, idx) => ({
    priority: idx + 1,
    target: target.ref,
    enabled: !(disableTail && chain.length > 2 && idx === chain.length - 1)
  }))

const profileFrom = (
  chains: ChainsByScenario,
  constraints: Record<string, unknown> | null
): Parameters<typeof applyRouterPreferences>[0] => ({
  entriesByScenario: {
    default: { agent: entriesFor(chains.default.agent, true), subagent: entriesFor(chains.default.subagent, false) },
    think: { agent: entriesFor(chains.think.agent, false), subagent: entriesFor(chains.think.subagent, false) },
    longContext: {
      agent: entriesFor(chains.longContext.agent, false),
      subagent: entriesFor(chains.longContext.subagent, false)
    },
    webSearch: {
      agent: entriesFor(chains.webSearch.agent, false),
      subagent: entriesFor(chains.webSearch.subagent, false)
    },
    image: { agent: entriesFor(chains.image.agent, false), subagent: entriesFor(chains.image.subagent, false) }
  },
  constraints
})

export interface PreferenceReport {
  live: 'written' | 'skipped'
  demoProfile: string
  warnings: string[]
}

/**
 * Seed the `live` chain (only while it is still empty) and always
 * (re)create the demo `cost-first` profile, which gives the profile
 * picker on the Routing screen a second option to switch between.
 */
export async function seedPreferences(prisma: PrismaClient, targets: DemoTarget[]): Promise<PreferenceReport> {
  const liveProfile = await prisma.routerPreferenceProfile.findUnique({
    where: { key: 'live' },
    include: { entries: { take: 1 } }
  })
  const liveIsEmpty = liveProfile === null || liveProfile.entries.length === 0
  const warnings: string[] = []

  if (liveIsEmpty) {
    const outcome = await applyRouterPreferences(profileFrom(buildChains(targets), null), prisma, 'live')
    warnings.push(...outcome.warnings)
  }

  // Cheapest-first ordering, plus a constraint blob that differs from the
  // defaults so the constraints editor has something to show.
  const costChains = buildChains([...targets].sort((a, b) => costOf(a) - costOf(b)))
  const outcome = await applyRouterPreferences(
    profileFrom(costChains, { allowEscalation: false, quotaSkipPct: 90, exhaustedBehavior: 'passthrough' }),
    prisma,
    DEMO_PROFILE_KEY
  )
  warnings.push(...outcome.warnings)

  return { live: liveIsEmpty ? 'written' : 'skipped', demoProfile: DEMO_PROFILE_KEY, warnings }
}

interface PresetSpec {
  name: string
  preferences: Record<ScenarioKey, string[]>
}

const PRESETS: PresetSpec[] = [
  {
    name: 'Subscription first',
    preferences: {
      default: ['sonnet', 'haiku'],
      think: ['opus', 'fable'],
      longContext: ['fable', 'sonnet'],
      webSearch: ['sonnet', 'haiku'],
      image: ['sonnet', 'haiku']
    }
  },
  {
    name: 'Cost saver',
    preferences: {
      default: ['flash-lite', 'luna', 'haiku'],
      think: ['terra', 'flash'],
      longContext: ['luna', 'flash'],
      webSearch: ['flash-lite', 'flash'],
      image: ['flash-lite', 'flash']
    }
  },
  {
    name: 'Max quality',
    preferences: {
      default: ['opus', 'sol'],
      think: ['fable', 'astra'],
      longContext: ['fable', 'astra'],
      webSearch: ['sol', 'opus'],
      image: ['sol', 'opus']
    }
  }
]

const routeOf = (chain: DemoTarget[]): RouteJson => ({
  primary: chain.length > 0 ? chain[0].ref : null,
  fallbacks: refsOf(chain.slice(1)),
  rules: []
})

/** Saved Router snapshots for Settings → Presets. Demo-owned. */
export async function seedRoutingPresets(prisma: PrismaClient, targets: DemoTarget[]): Promise<number> {
  const rows = PRESETS.map((preset, idx) => {
    const routes = (scenario: ScenarioKey): { agent: RouteJson; subagent: RouteJson } => {
      const chain = pickChain(targets, preset.preferences[scenario], 2)
      // The subagent lane leads with the cheaper tail of the same chain —
      // the shape most of these presets exist to express.
      return { agent: routeOf(chain), subagent: routeOf([...chain.slice(1), ...chain.slice(0, 1)]) }
    }
    return {
      id: demoId('preset', idx + 1),
      name: preset.name,
      config: {
        default: routes('default'),
        think: routes('think'),
        longContext: { ...routes('longContext'), threshold: LONG_CONTEXT_THRESHOLD },
        webSearch: routes('webSearch'),
        image: routes('image'),
        persona: null
      }
    }
  })
  await prisma.routingPreset.createMany({ data: rows })
  return rows.length
}

// The scheduler's own vocabulary (see RoutingWeightChange.reason).
const WEIGHT_REASONS = [
  'quota_drop',
  'quota_recovered',
  'error_rate',
  'reset_soon',
  'probe_floor',
  'hold_guard',
  'stale_quota'
] as const

/**
 * A few hours of scheduler weight history, which is what Overview's
 * failover feed and the routing scheduler panel render.
 */
export async function seedWeightChanges(
  prisma: PrismaClient,
  targets: DemoTarget[],
  random: Random,
  now: number
): Promise<number> {
  const pool = targets.slice(0, Math.min(targets.length, 6))
  if (pool.length === 0) return 0
  const rows = Array.from({ length: 14 }, (_, idx) => {
    const from = random.int(20, 100) / 100
    const drift = random.int(-45, 35) / 100
    const to = Math.min(1, Math.max(0, Number((from + drift).toFixed(2))))
    const tickAt = new Date(now - (idx + 1) * random.int(6, 22) * 60_000)
    return {
      id: demoId('weight', idx + 1),
      target: pool[idx % pool.length].ref,
      fromWeight: from,
      toWeight: to,
      reason: random.pick(WEIGHT_REASONS),
      tickAt,
      createdAt: tickAt
    }
  })
  await prisma.routingWeightChange.createMany({ data: rows })
  return rows.length
}

export interface SurfaceReport {
  updated: string[]
  skipped: string[]
}

// Which surface gets which mode. Anthropic traffic routes through the
// live chain; the OpenAI chat surface demonstrates a per-surface profile
// override; the remaining two stay in passthrough so both states are on
// screen at once.
const SURFACE_MODES: Array<{ surface: string; routingMode: string; profileKey: string | null }> = [
  { surface: 'anthropic-messages', routingMode: 'routed', profileKey: null },
  { surface: 'openai-chat', routingMode: 'routed', profileKey: DEMO_PROFILE_KEY }
]

/**
 * Point two of the four surfaces at a chain — but only while they still
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
