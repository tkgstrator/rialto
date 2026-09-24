/**
 * Turn one profile's old chain into provider tier aliases and scenario
 * routes.
 *
 * Pure: the database runner (`backfill-tier-routes.ts`) loads the chain
 * and writes what this returns. Kept apart so every decision below is
 * tested without a database — this runs once per profile, on a live
 * install, and what it gets wrong silently re-routes traffic.
 *
 * The old chain already had the shape routing has again: a list per
 * scenario and lane. What changes is what a row holds — a provider and a
 * tier on it instead of a model — so the conversion is mostly one of
 * naming:
 *
 *   - every entry of default / think / longContext, in both the agent and
 *     the subagent lane, becomes a route in the same list, in the same
 *     order, switched on or off as the entry was;
 *   - the route names the entry's provider and the tier its model is (a
 *     manual tier when one was set, else what the name says), and the
 *     provider's alias for that tier is claimed for the model when the
 *     slot is free;
 *   - a model whose name says no tier (a gpt-* on Codex) is aliased as a
 *     tier its provider has free, and reached through that;
 *   - two entries that land on the same provider · tier in one list
 *     become one route.
 *
 * The webSearch and image lanes are not converted — they are no longer
 * scenarios — and are counted in the notes. Every other difference is a
 * note too.
 */

import { tierOf } from '../../llms/router/request-signals'
import { type ModelTier, ModelTierSchema, type RoutingLane, type RoutingScenario } from '../../schemas/domain/tier-route'

export interface ChainEntryInput {
  priority: number
  enabled: boolean
  model: {
    id: string
    name: string
    manualTier: string | null
    deprecated: boolean
    enabled: boolean
  }
  provider: { id: string; name: string; enabled: boolean }
}

export interface ExistingAlias {
  modelId: string
  modelName: string
}

export interface ConvertedLane {
  scenario: RoutingScenario
  lane: RoutingLane
  entries: readonly ChainEntryInput[]
}

export interface PlanInput {
  // The lists to convert, in the order their entries claim aliases: the
  // default agent list first, so the models most traffic reaches get the
  // provider's slots.
  lanes: readonly ConvertedLane[]
  // Aliases already in the database, keyed `${providerId}|${tier}`. Never
  // overwritten: an alias another profile (or an operator) set wins.
  aliases: ReadonlyMap<string, ExistingAlias>
  // Entries in lanes this conversion does not read, for the notes.
  ignoredLanes: readonly { lane: string; count: number }[]
}

export interface PlannedAlias {
  providerId: string
  tier: ModelTier
  modelId: string
}

export interface PlannedRoute {
  scenario: RoutingScenario
  lane: RoutingLane
  priority: number
  providerId: string
  targetTier: ModelTier
  enabled: boolean
}

export interface PlanOutput {
  aliases: PlannedAlias[]
  routes: PlannedRoute[]
  notes: string[]
}

const key = (providerId: string, tier: ModelTier): string => `${providerId}|${tier}`
const label = (e: ChainEntryInput): string => `${e.provider.name},${e.model.name}`

// Slots a tierless model takes when its provider has one free, the tier
// most traffic asks for first.
const FREE_SLOT_ORDER: readonly ModelTier[] = ['sonnet', 'opus', 'haiku', 'fable']

// The tier the old chain saw: a manual tier when set, else the name.
const tierOfEntry = (e: ChainEntryInput): ModelTier | null => {
  if (e.model.manualTier !== null) {
    const manual = ModelTierSchema.safeParse(e.model.manualTier)
    if (manual.success) return manual.data
  }
  const inferred = tierOf(e.model.name)
  return inferred === undefined ? null : inferred
}

// Whether the entry, its model and its provider are all switched on.
const routable = (e: ChainEntryInput): boolean => e.enabled && e.model.enabled && e.provider.enabled

// The slot a tierless model is reached through: one its provider already
// points at it, else the first free one, else sonnet (reached through
// whatever holds it, which the notes say).
const slotForTierless = (e: ChainEntryInput, aliases: ReadonlyMap<string, ExistingAlias>): ModelTier => {
  const held = FREE_SLOT_ORDER.find((tier) => aliases.get(key(e.provider.id, tier))?.modelId === e.model.id)
  if (held !== undefined) return held
  const free = FREE_SLOT_ORDER.find((tier) => !aliases.has(key(e.provider.id, tier)))
  return free === undefined ? 'sonnet' : free
}

const slotOf = (e: ChainEntryInput, aliases: ReadonlyMap<string, ExistingAlias>): ModelTier => {
  const own = tierOfEntry(e)
  return own === null ? slotForTierless(e, aliases) : own
}

type Claim = { entry: ChainEntryInput; rank: (string | number)[] }

const compareRank = (a: Claim, b: Claim): number => {
  for (const [i, value] of a.rank.entries()) {
    const other = b.rank[i]
    if (value < other) return -1
    if (value > other) return 1
  }
  return 0
}

// Pass 1 — aliases. Entries bid for their provider's slot in rank order:
// routable before switched off, then list order (the default agent list
// first), priority, a non-deprecated model, the name. Tiered models bid
// before tierless ones, so a named Sonnet is not displaced from the
// sonnet slot by a gpt-* that could have taken any slot. `aliases` is
// updated in place with what is created.
function claimAliases(input: PlanInput, aliases: Map<string, ExistingAlias>): PlannedAlias[] {
  const claims: Claim[] = input.lanes.flatMap((lane, laneIndex) =>
    lane.entries.map((entry) => ({
      entry,
      rank: [
        tierOfEntry(entry) === null ? 1 : 0,
        routable(entry) ? 0 : 1,
        laneIndex,
        entry.priority,
        entry.model.deprecated ? 1 : 0,
        entry.model.name
      ]
    }))
  )
  const created: PlannedAlias[] = []
  for (const claim of [...claims].sort(compareRank)) {
    const slot = slotOf(claim.entry, aliases)
    const k = key(claim.entry.provider.id, slot)
    if (aliases.has(k)) continue
    aliases.set(k, { modelId: claim.entry.model.id, modelName: claim.entry.model.name })
    created.push({ providerId: claim.entry.provider.id, tier: slot, modelId: claim.entry.model.id })
  }
  return created
}

type Hop = { k: string; providerId: string; targetTier: ModelTier; enabled: boolean }

// Pass 2, one list: the chain in order, one route per provider · tier.
function routesFor(lane: ConvertedLane, aliases: ReadonlyMap<string, ExistingAlias>, notes: string[]): Hop[] {
  const where = `${lane.scenario}/${lane.lane}`
  const hops: Hop[] = []
  for (const entry of [...lane.entries].sort((a, b) => a.priority - b.priority)) {
    const slot = slotOf(entry, aliases)
    const k = key(entry.provider.id, slot)
    const resolved = aliases.get(k)
    if (resolved !== undefined && resolved.modelId !== entry.model.id) {
      notes.push(`${where}: ${label(entry)} is reached through ${entry.provider.name}'s ${slot} alias, which is ${resolved.modelName}`)
    }
    const existing = hops.findIndex((h) => h.k === k)
    if (existing >= 0) {
      notes.push(`${where}: ${label(entry)} collapsed into the ${entry.provider.name} · ${slot} route already listed`)
      // A later duplicate that is on rescues a route switched off earlier,
      // taking its position the way the chain would have.
      if (entry.enabled && !hops[existing].enabled) {
        const [hop] = hops.splice(existing, 1)
        hops.push({ ...hop, enabled: true })
      }
      continue
    }
    hops.push({ k, providerId: entry.provider.id, targetTier: slot, enabled: entry.enabled })
  }
  return hops
}

const laneNote = (lane: { lane: string; count: number }): string =>
  `${lane.lane}: ${lane.count} entr${lane.count === 1 ? 'y' : 'ies'} not converted (web search and image are no longer scenarios)`

export function planTierRoutes(input: PlanInput): PlanOutput {
  const notes: string[] = []
  const aliases = new Map(input.aliases)
  const created = claimAliases(input, aliases)
  const routes = input.lanes.flatMap((lane) =>
    routesFor(lane, aliases, notes).map(
      (h, i): PlannedRoute => ({
        scenario: lane.scenario,
        lane: lane.lane,
        priority: i + 1,
        providerId: h.providerId,
        targetTier: h.targetTier,
        enabled: h.enabled
      })
    )
  )
  notes.push(...input.ignoredLanes.filter((lane) => lane.count > 0).map(laneNote))
  return { aliases: created, routes, notes }
}
