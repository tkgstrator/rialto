/**
 * Pure derivations for the Routing screen.
 *
 * Everything here answers a question a row or a cell asks of the loaded
 * profile, the draft and the scheduler snapshot — what a route resolves
 * to, what state it is in, whether the draft differs from what is saved —
 * without touching React, so each answer can be tested on its own.
 */
import type {
  RoutingConstraintsWire,
  RoutingSchedulerStateResponse,
  RoutingSchedulerTargetState,
  TierAliasWire,
  TierProfileViewWire,
  TierRouteResolutionWire
} from '@/lib/api'
import { ROUTE_TIER_ORDER } from '@/lib/api-types'
import type { Provider } from '@/schemas/domain/provider'
import type { DraftRoute, EnabledTarget, ModelTier, RouteResolution, RouteState, RouteTier, TierDraft } from './types'

/**
 * Every "provider,model" the operator has left routable: providers switched
 * off and models in `transformer._disabledModels` drop out, matching the
 * gate the Providers screen applies.
 */
export function enabledTargets(providers: readonly Provider[]): EnabledTarget[] {
  const out: EnabledTarget[] = []
  for (const provider of providers) {
    if (provider.enabled === false) continue
    const disabled = new Set(provider.transformer?._disabledModels)
    for (const model of [...provider.models].sort((a, b) => a.localeCompare(b))) {
      if (disabled.has(model)) continue
      out.push({ target: `${provider.name},${model}`, provider: provider.name, model })
    }
  }
  return out
}

/**
 * The providers a new route may name.
 *
 * A switched-off provider is left out rather than offered: a route to it
 * would be kept but never taken, and the Add route dialog is where that
 * mistake is cheapest to prevent.
 */
export function enabledProviderNames(providers: readonly Provider[]): string[] {
  return providers.filter((provider) => provider.enabled !== false).map((provider) => provider.name)
}

/** The scheduler's per-target readings keyed by "provider,model", so a row can look up its own. */
export function targetIndex(state: RoutingSchedulerStateResponse | null): Map<string, RoutingSchedulerTargetState> {
  const out = new Map<string, RoutingSchedulerTargetState>()
  // A server from before the scheduler published per-target readings
  // answers without `targets`; every row reading "ok" is better than the
  // screen failing to render.
  if (state === null || !Array.isArray(state.targets)) return out
  for (const entry of state.targets) out.set(entry.target, entry)
  return out
}

/**
 * One key per provider · tier.
 *
 * Tier first: a tier name never contains a colon, so the key cannot be
 * ambiguous whatever the provider happens to be called.
 */
export const routeKey = (provider: string, tier: ModelTier): string => `${tier}:${provider}`

/** Constraints as the server defaults them — what a profile with no row reads as. */
export const DEFAULT_CONSTRAINTS: RoutingConstraintsWire = {
  exhaustedBehavior: '429',
  quotaSkipPct: 100,
  errorRateSkipPct: 0.5,
  minHealthSamples: 5
}

export function emptyDraft(): TierDraft {
  return {
    routes: { fable: [], opus: [], sonnet: [], haiku: [], other: [] },
    constraints: { ...DEFAULT_CONSTRAINTS }
  }
}

/**
 * The write-shaped copy of a loaded profile.
 *
 * Built field by field in a fixed order rather than spread from the view,
 * so the draft and its baseline serialise identically and `draftDiffers`
 * can compare them as strings.
 */
export function draftOf(view: TierProfileViewWire): TierDraft {
  const routes = emptyDraft().routes
  for (const tier of ROUTE_TIER_ORDER) {
    routes[tier] = view.routes[tier].map((route) => ({
      provider: route.provider,
      targetTier: route.targetTier,
      enabled: route.enabled
    }))
  }
  const c = view.constraints
  return {
    routes,
    constraints: {
      exhaustedBehavior: c.exhaustedBehavior,
      quotaSkipPct: c.quotaSkipPct,
      errorRateSkipPct: c.errorRateSkipPct,
      minHealthSamples: c.minHealthSamples
    }
  }
}

/** Whether an edit has changed anything one PUT would write. */
export function draftDiffers(a: TierDraft, b: TierDraft): boolean {
  return JSON.stringify(a) !== JSON.stringify(b)
}

/**
 * Every resolution the loaded profile carries, keyed by provider · tier.
 *
 * The same provider · tier resolves identically in every group — the
 * alias belongs to the provider, not to the route — so a route moved or
 * re-added during an edit can borrow a resolution from any group.
 */
export function resolutionIndex(view: TierProfileViewWire | null): Map<string, TierRouteResolutionWire | null> {
  const out = new Map<string, TierRouteResolutionWire | null>()
  if (view === null) return out
  for (const tier of ROUTE_TIER_ORDER) {
    for (const route of view.routes[tier]) out.set(routeKey(route.provider, route.targetTier), route.resolved)
  }
  return out
}

/** The model each provider · tier alias names today, or null where none is set. */
export function aliasIndex(aliases: readonly TierAliasWire[] | null): Map<string, string | null> {
  const out = new Map<string, string | null>()
  if (aliases === null) return out
  for (const alias of aliases) out.set(routeKey(alias.provider, alias.tier), alias.model)
  return out
}

/**
 * What a row resolves to: the server's answer where the loaded profile
 * has one, else the alias list's, else nothing until Save.
 */
export function resolveRoute(
  route: DraftRoute,
  resolutions: ReadonlyMap<string, TierRouteResolutionWire | null>,
  aliases: ReadonlyMap<string, string | null>
): RouteResolution {
  const key = routeKey(route.provider, route.targetTier)
  const resolved = resolutions.get(key)
  if (resolved === null) return { kind: 'unset' }
  if (resolved !== undefined) return { kind: 'resolved', resolution: resolved }
  const alias = aliases.get(key)
  if (alias === null) return { kind: 'unset' }
  return { kind: 'pending', model: alias === undefined ? null : alias }
}

/**
 * A route's state, from the scheduler's reading of the target it resolves to.
 *
 * `exhausted` is the scheduler's own verdict — the same one the tier
 * router skips a route on — so a row reads "exhausted" exactly when a
 * request would pass it by for quota. A target the scheduler has no
 * budget for (an api_key provider, a cold start) is not held back on
 * quota by the router, so it is not here either: `ok`.
 *
 * The route's own switch is not a state. A switched-off row is already
 * dimmed with its toggle off; its State still reports what the target
 * would do if switched back on, which is the thing worth knowing before
 * flipping it.
 */
export function routeState(
  resolution: RouteResolution,
  provider: string,
  targets: ReadonlyMap<string, RoutingSchedulerTargetState>
): RouteState {
  if (resolution.kind === 'unset') return { kind: 'unset' }
  if (resolution.kind === 'pending') return { kind: 'pending' }
  if (!resolution.resolution.targetEnabled) return { kind: 'off' }
  const reading = targets.get(`${provider},${resolution.resolution.model}`)
  if (reading === undefined) return { kind: 'ok' }
  if (reading.exhausted) return { kind: 'exhausted', until: reading.resetAt }
  const remaining = reading.remainingBudgetPct
  return remaining !== null && remaining < 100 ? { kind: 'used', pct: Math.round(100 - remaining) } : { kind: 'ok' }
}

/**
 * Whether a route answers its group with another tier on purpose.
 *
 * "Other" is the group of names with no Claude family, so there is no
 * tier to substitute for — any tier a route names there is simply the
 * tier it names.
 */
export function substitutes(group: RouteTier, target: ModelTier): boolean {
  return group !== 'other' && group !== target
}

/** Move one route within its group; an out-of-range target leaves the list as it was. */
export function moveRoute(routes: readonly DraftRoute[], from: number, to: number): DraftRoute[] {
  if (from === to || from < 0 || to < 0 || from >= routes.length || to >= routes.length) return [...routes]
  const next = [...routes]
  const [pulled] = next.splice(from, 1)
  next.splice(to, 0, pulled)
  return next
}

/** Whether a group already holds this provider · tier — the duplicate the server would drop. */
export function hasRoute(routes: readonly DraftRoute[], provider: string, tier: ModelTier): boolean {
  return routes.some((route) => route.provider === provider && route.targetTier === tier)
}

export interface MapCounts {
  total: number
  off: number
  unresolved: number
}

/** The footer's totals across every group of the draft. */
export function mapCounts(draft: TierDraft, resolve: (route: DraftRoute) => RouteResolution): MapCounts {
  const all = ROUTE_TIER_ORDER.flatMap((tier) => draft.routes[tier])
  return {
    total: all.length,
    off: all.filter((route) => !route.enabled).length,
    unresolved: all.filter((route) => resolve(route).kind === 'unset').length
  }
}

export type ConstraintEdit =
  | { kind: 'exhaustedBehavior'; value: RoutingConstraintsWire['exhaustedBehavior'] }
  | { kind: 'quotaSkipPct'; value: number }
  | { kind: 'errorRateSkipPct'; value: number }
  | { kind: 'minHealthSamples'; value: number }

/**
 * One edit, merged over the constraints that are there.
 *
 * The error-rate cell is edited as a percentage because that is how it
 * reads; the profile stores it as a fraction, which is what the router
 * compares against, so the conversion happens exactly once, here.
 */
export function applyConstraintEdit(constraints: RoutingConstraintsWire, edit: ConstraintEdit): RoutingConstraintsWire {
  if (edit.kind === 'exhaustedBehavior') return { ...constraints, exhaustedBehavior: edit.value }
  if (edit.kind === 'quotaSkipPct') return { ...constraints, quotaSkipPct: edit.value }
  if (edit.kind === 'errorRateSkipPct') return { ...constraints, errorRateSkipPct: edit.value / 100 }
  return { ...constraints, minHealthSamples: edit.value }
}

/** The stored error-rate fraction as the whole percentage its cell shows. */
export const errorRatePctOf = (constraints: RoutingConstraintsWire): number =>
  Math.round(constraints.errorRateSkipPct * 100)

/**
 * A percentage entry as a whole number, 0–100, or null when the text is
 * not one. Whole only: the cells read as `100%`, and a fraction there
 * would be a precision the readings it is compared with do not have.
 */
export function parseWholePercent(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,3}$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value <= 100 ? value : null
}

/** A sample count: a non-negative whole number of sensible size, or null. */
export function parseSampleCount(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,6}$/.test(trimmed)) return null
  return Number(trimmed)
}
