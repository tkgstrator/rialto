/**
 * Turn one profile's old chain into provider tier aliases and tier routes.
 *
 * Pure: the database runner (`backfill-tier-routes.ts`) loads the chain
 * and writes what this returns. Kept apart so every decision below is
 * tested without a database — this runs once per profile, on a live
 * install, and what it gets wrong silently re-routes traffic.
 *
 * What is read: the profile's default/agent chain, for every requested
 * tier. Other scenarios and the subagent lanes are not converted — the
 * classifier sent a request there by size, thinking or effort, not by the
 * tier it asked for, so no single tier row can reproduce them; they are
 * counted in the notes for the operator to re-add by hand.
 *
 * What is reproduced, per requested tier T:
 *   - the order: routes keep the chain's priority order;
 *   - the tier gates: an entry the profile's allowEscalation /
 *     allowDemotion would refuse for T becomes a route switched off;
 *   - the nearest-tier fallback (P0-1): when the gates leave T with
 *     nothing that can serve, the refused entries are switched on,
 *     nearest tier first and the cheaper side first on a tie — unless the
 *     profile set tierFallback 'refuse';
 *   - "other" (a model name with no Claude family): every entry, as the
 *     gates never applied to an unclassifiable request.
 *
 * What is not: pace widening, and a chain holding two models of the same
 * provider and tier (they become one route to that provider's alias).
 * Every such difference is a note.
 */

import { tierOf } from '../../llms/router/request-signals'
import { type ModelTier, ModelTierSchema, ROUTE_TIERS, type RouteTier } from '../../schemas/domain/tier-route'

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

export interface PlanInput {
  entries: readonly ChainEntryInput[]
  allowEscalation: boolean
  allowDemotion: boolean
  tierFallback: 'nearest' | 'refuse'
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
  requestedTier: RouteTier
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

const TIERS = ModelTierSchema.options
const key = (providerId: string, tier: ModelTier): string => `${providerId}|${tier}`
const label = (e: ChainEntryInput): string => `${e.provider.name},${e.model.name}`

// The tier the old selector saw: a manual tier when set, else the name.
const tierOfEntry = (e: ChainEntryInput): ModelTier | null => {
  if (e.model.manualTier !== null) {
    const manual = ModelTierSchema.safeParse(e.model.manualTier)
    if (manual.success) return manual.data
  }
  const inferred = tierOf(e.model.name)
  return inferred === undefined ? null : inferred
}

// Whether the entry, its model and its provider are all switched on —
// what the old request path folded into the entry before selecting.
const routable = (e: ChainEntryInput): boolean => e.enabled && e.model.enabled && e.provider.enabled

// The old tier gate for requested tier T (quota-router/selection.ts
// `tierMatches`, less the pace override the runtime has stopped passing).
const gateAllows = (t: ModelTier | null, requested: RouteTier, input: PlanInput): boolean => {
  if (requested === 'other' || t === null || t === requested) return true
  return TIERS.indexOf(t) < TIERS.indexOf(requested) ? input.allowEscalation : input.allowDemotion
}

// Nearest tier first, the cheaper side first on a tie — the order the
// P0-1 retry used. Unknown tiers were never refused, so never retried.
const retryRank = (t: ModelTier | null, requested: ModelTier): number => {
  if (t === null) return Number.MAX_SAFE_INTEGER
  const idx = TIERS.indexOf(t)
  const req = TIERS.indexOf(requested)
  return Math.abs(idx - req) * 2 + (idx < req ? 1 : 0)
}

/**
 * Which tier of its provider an entry's model is reached through.
 *
 * Its own tier when it has one. A model with none (a gpt-* on Codex) was
 * admitted for any requested tier, so it is aliased as the tier being
 * converted when it holds that slot, else as a tier it already holds (so
 * the route still reaches this model), else as the tier being converted;
 * for "other", the first slot its provider still has free.
 */
const slotOf = (e: ChainEntryInput, requested: RouteTier, aliases: ReadonlyMap<string, ExistingAlias>): ModelTier => {
  const own = tierOfEntry(e)
  if (own !== null) return own
  const holds = (tier: ModelTier): boolean => aliases.get(key(e.provider.id, tier))?.modelId === e.model.id
  if (requested !== 'other' && holds(requested)) return requested
  const held = TIERS.find(holds)
  if (held !== undefined) return held
  if (requested !== 'other') return requested
  const free = (['sonnet', 'opus', 'haiku', 'fable'] as const).find((tier) => !aliases.has(key(e.provider.id, tier)))
  return free === undefined ? 'sonnet' : free
}

// Sort key for claiming an alias: an entry of the tier being converted
// before one of another tier, a routable entry before one switched off,
// then chain order; among same-priority ties a non-deprecated model, then
// the name, so the outcome does not depend on row order.
type Claim = { entry: ChainEntryInput; requested: RouteTier; slot: ModelTier; rank: (string | number)[] }

const compareRank = (a: Claim, b: Claim): number => {
  for (const [i, value] of a.rank.entries()) {
    const other = b.rank[i]
    if (value < other) return -1
    if (value > other) return 1
  }
  return 0
}

// Pass 1 — aliases. Every (requested tier, entry) pair bids for its
// provider's slot; the best-ranked bid for an empty slot takes it. Returns
// the aliases created; `aliases` is updated in place with them.
function claimAliases(
  entries: readonly ChainEntryInput[],
  initial: ReadonlyMap<string, ExistingAlias>,
  aliases: Map<string, ExistingAlias>
): PlannedAlias[] {
  const claims: Claim[] = ROUTE_TIERS.flatMap((requested) =>
    entries.map((entry) => {
      const t = tierOfEntry(entry)
      return {
        entry,
        requested,
        slot: slotOf(entry, requested, initial),
        rank: [
          t === requested ? 0 : t === null ? 2 : 1,
          routable(entry) ? 0 : 1,
          entry.priority,
          entry.model.deprecated ? 1 : 0,
          entry.model.name
        ]
      }
    })
  )
  const created: PlannedAlias[] = []
  for (const claim of [...claims].sort(compareRank)) {
    const k = key(claim.entry.provider.id, claim.slot)
    if (aliases.has(k)) continue
    aliases.set(k, { modelId: claim.entry.model.id, modelName: claim.entry.model.name })
    created.push({ providerId: claim.entry.provider.id, tier: claim.slot, modelId: claim.entry.model.id })
  }
  return created
}

type Hop = {
  k: string
  providerId: string
  targetTier: ModelTier
  enabled: boolean
  // Switched on in the chain but refused by the tier gate for this tier.
  gated: boolean
  t: ModelTier | null
  routable: boolean
}

// Pass 2, one requested tier: the chain in order, one hop per
// provider·tier, each switched on only where the old gate allowed it.
function hopsFor(
  requested: RouteTier,
  entries: readonly ChainEntryInput[],
  aliases: ReadonlyMap<string, ExistingAlias>,
  input: PlanInput,
  notes: string[]
): Hop[] {
  const hops: Hop[] = []
  for (const entry of entries) {
    const t = tierOfEntry(entry)
    const allowed = gateAllows(t, requested, input)
    const slot = slotOf(entry, requested, aliases)
    const k = key(entry.provider.id, slot)
    const resolved = aliases.get(k)
    if (resolved !== undefined && resolved.modelId !== entry.model.id) {
      notes.push(
        `${requested}: ${label(entry)} is reached through ${entry.provider.name}'s ${slot} alias, which is ${resolved.modelName}`
      )
    }
    const existing = hops.findIndex((h) => h.k === k)
    if (existing >= 0) {
      notes.push(
        `${requested}: ${label(entry)} collapsed into the ${entry.provider.name} · ${slot} route already listed`
      )
      // A later duplicate that can serve rescues a route switched off
      // earlier, taking its position the way the chain would have.
      if (entry.enabled && allowed && routable(entry) && !hops[existing].enabled) {
        const [hop] = hops.splice(existing, 1)
        hops.push({ ...hop, enabled: true, gated: false, routable: true })
      }
      continue
    }
    if (entry.enabled && !allowed) {
      notes.push(`${requested}: ${label(entry)} was refused by tier substitution; added switched off`)
    }
    hops.push({
      k,
      providerId: entry.provider.id,
      targetTier: slot,
      enabled: entry.enabled && allowed,
      gated: entry.enabled && !allowed,
      t,
      routable: routable(entry)
    })
  }
  return hops
}

// The P0-1 fallback: when nothing of an allowed tier can serve, the
// refused hops do, nearest tier first. Array sort is stable, so equal
// ranks keep chain order; hops that were never candidates follow.
function withNearestFallback(requested: RouteTier, hops: Hop[], input: PlanInput, notes: string[]): Hop[] {
  if (requested === 'other' || input.tierFallback === 'refuse') return hops
  if (hops.some((h) => h.enabled && h.routable)) return hops
  const refused = hops.filter((h) => h.gated)
  if (refused.length === 0) return hops
  notes.push(`${requested}: no route of an allowed tier; the nearest tier serves it, as it did`)
  return [
    ...[...refused]
      .sort((a, b) => retryRank(a.t, requested) - retryRank(b.t, requested))
      .map((h) => ({ ...h, enabled: true })),
    ...hops.filter((h) => !h.gated)
  ]
}

const laneNote = (lane: { lane: string; count: number }): string =>
  `${lane.lane}: ${lane.count} entr${lane.count === 1 ? 'y' : 'ies'} not converted (lanes other than default/agent are gone)`

export function planTierRoutes(input: PlanInput): PlanOutput {
  const notes: string[] = []
  const entries = [...input.entries].sort((a, b) => a.priority - b.priority)
  const aliases = new Map(input.aliases)
  const created = claimAliases(entries, input.aliases, aliases)
  const routes = ROUTE_TIERS.flatMap((requested) =>
    withNearestFallback(requested, hopsFor(requested, entries, aliases, input, notes), input, notes).map(
      (h, i): PlannedRoute => ({
        requestedTier: requested,
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
