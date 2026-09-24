/**
 * What the Routing screen's tier map derives from the loaded profile,
 * the draft over it and the scheduler snapshot.
 *
 * The three questions each row asks — what does this route resolve to,
 * what state is it in, and has the edit changed anything — are pure, so
 * they are pinned here rather than through the rendered table.
 */

import { describe, expect, test } from 'bun:test'
import {
  aliasIndex,
  DEFAULT_CONSTRAINTS,
  draftDiffers,
  draftOf,
  hasRoute,
  mapCounts,
  moveRoute,
  resolutionIndex,
  resolveRoute,
  routeState,
  substitutes,
  targetIndex
} from '../../src/components/rialto/routing/derive'
import type { DraftRoute, RouteResolution } from '../../src/components/rialto/routing/types'
import type {
  RoutingSchedulerStateResponse,
  RoutingSchedulerTargetState,
  TierAliasWire,
  TierProfileViewWire,
  TierRouteResolutionWire
} from '../../src/lib/api-types'

const resolution = (over: Partial<TierRouteResolutionWire> = {}): TierRouteResolutionWire => ({
  model: 'claude-sonnet-5',
  targetEnabled: true,
  hostsWebSearch: true,
  contextWindow: 200_000,
  ...over
})

const view: TierProfileViewWire = {
  key: 'live',
  routes: {
    fable: [],
    opus: [{ provider: 'codex', targetTier: 'opus', enabled: true, resolved: resolution({ model: 'gpt-5.5' }) }],
    sonnet: [
      { provider: 'claude-code', targetTier: 'sonnet', enabled: true, resolved: resolution() },
      { provider: 'gemini-cli', targetTier: 'sonnet', enabled: false, resolved: null }
    ],
    haiku: [],
    other: []
  },
  constraints: { ...DEFAULT_CONSTRAINTS }
}

const route = (provider: string, targetTier: DraftRoute['targetTier'], enabled = true): DraftRoute => ({
  provider,
  targetTier,
  enabled
})

const alias = (provider: string, tier: TierAliasWire['tier'], model: string | null): TierAliasWire => ({
  provider,
  tier,
  model,
  updatedAt: null,
  candidates: []
})

const snapshot = (targets: RoutingSchedulerTargetState[]): RoutingSchedulerStateResponse => ({
  tickAt: '2026-09-24T10:00:00Z',
  tickCount: 1,
  consecutiveFailures: 0,
  degraded: false,
  targets,
  accounts: [],
  soonestResetAt: null
})

const reading = (over: Partial<RoutingSchedulerTargetState> = {}): RoutingSchedulerTargetState => ({
  target: 'claude-code,claude-sonnet-5',
  exhausted: false,
  remainingBudgetPct: null,
  resetAt: null,
  ...over
})

describe('draftOf / draftDiffers', () => {
  test('the draft carries what a PUT writes and nothing it does not', () => {
    const draft = draftOf(view)
    expect(draft.routes.sonnet).toEqual([route('claude-code', 'sonnet'), route('gemini-cli', 'sonnet', false)])
    expect(draft.routes.opus[0]).not.toHaveProperty('resolved')
    expect(draft.constraints).toEqual(DEFAULT_CONSTRAINTS)
  })

  test('a draft read twice from the same profile is not a change', () => {
    expect(draftDiffers(draftOf(view), draftOf(view))).toBe(false)
  })

  test('an edit is a change, and undoing it by hand is not', () => {
    const base = draftOf(view)
    const toggled = { ...base, routes: { ...base.routes, opus: [route('codex', 'opus', false)] } }
    expect(draftDiffers(toggled, base)).toBe(true)
    const back = { ...toggled, routes: { ...toggled.routes, opus: [route('codex', 'opus', true)] } }
    expect(draftDiffers(back, base)).toBe(false)
  })
})

describe('resolveRoute', () => {
  const resolutions = resolutionIndex(view)
  const aliases = aliasIndex([alias('claude-code', 'haiku', 'claude-haiku-4-5'), alias('codex', 'haiku', null)])

  test('a route the profile resolved reads the server answer', () => {
    expect(resolveRoute(route('claude-code', 'sonnet'), resolutions, aliases)).toEqual({
      kind: 'resolved',
      resolution: resolution()
    })
  })

  test('a provider · tier resolves the same whichever group it was read from', () => {
    // Loaded under Opus; an edit that adds it to Fable borrows the answer.
    expect(resolveRoute(route('codex', 'opus'), resolutions, aliases)).toEqual({
      kind: 'resolved',
      resolution: resolution({ model: 'gpt-5.5' })
    })
  })

  test('an alias the server found unset reads unset', () => {
    expect(resolveRoute(route('gemini-cli', 'sonnet'), resolutions, aliases)).toEqual({ kind: 'unset' })
  })

  test('a route added during the edit names the alias model, and waits for Save for the rest', () => {
    expect(resolveRoute(route('claude-code', 'haiku'), resolutions, aliases)).toEqual({
      kind: 'pending',
      model: 'claude-haiku-4-5'
    })
    expect(resolveRoute(route('codex', 'haiku'), resolutions, aliases)).toEqual({ kind: 'unset' })
  })

  test('with no alias list, a new route claims nothing', () => {
    expect(resolveRoute(route('deepseek', 'fable'), resolutions, aliasIndex(null))).toEqual({
      kind: 'pending',
      model: null
    })
  })
})

describe('routeState', () => {
  const resolved: RouteResolution = { kind: 'resolved', resolution: resolution() }

  test('a target the scheduler has no reading for is not held back: ok', () => {
    expect(routeState(resolved, 'claude-code', targetIndex(null))).toEqual({ kind: 'ok' })
    expect(routeState(resolved, 'claude-code', targetIndex(snapshot([])))).toEqual({ kind: 'ok' })
  })

  test('a partly used budget reads as the share used', () => {
    const targets = targetIndex(snapshot([reading({ remainingBudgetPct: 28 })]))
    expect(routeState(resolved, 'claude-code', targets)).toEqual({ kind: 'used', pct: 72 })
  })

  test('a full or unknown budget reads ok', () => {
    expect(routeState(resolved, 'claude-code', targetIndex(snapshot([reading({ remainingBudgetPct: 100 })])))).toEqual({
      kind: 'ok'
    })
    expect(routeState(resolved, 'claude-code', targetIndex(snapshot([reading()])))).toEqual({ kind: 'ok' })
  })

  test('the scheduler saying exhausted wins over any budget, and carries its reset', () => {
    const targets = targetIndex(
      snapshot([reading({ exhausted: true, remainingBudgetPct: 40, resetAt: '2026-09-24T14:05:00Z' })])
    )
    expect(routeState(resolved, 'claude-code', targets)).toEqual({ kind: 'exhausted', until: '2026-09-24T14:05:00Z' })
  })

  test('the reading is looked up by the model the route resolves to, on its own provider', () => {
    const targets = targetIndex(snapshot([reading({ target: 'anthropic,claude-sonnet-5', exhausted: true })]))
    expect(routeState(resolved, 'claude-code', targets)).toEqual({ kind: 'ok' })
  })

  test('the route cannot be taken for reasons of its own before any reading applies', () => {
    const targets = targetIndex(snapshot([reading({ exhausted: true })]))
    expect(routeState({ kind: 'unset' }, 'claude-code', targets)).toEqual({ kind: 'unset' })
    expect(routeState({ kind: 'pending', model: 'x' }, 'claude-code', targets)).toEqual({ kind: 'pending' })
    expect(
      routeState({ kind: 'resolved', resolution: resolution({ targetEnabled: false }) }, 'claude-code', targets)
    ).toEqual({ kind: 'off' })
  })
})

describe('the rest of the row', () => {
  test('a route of another tier substitutes, except in Other, which has no tier to substitute for', () => {
    expect(substitutes('haiku', 'sonnet')).toBe(true)
    expect(substitutes('sonnet', 'sonnet')).toBe(false)
    expect(substitutes('other', 'opus')).toBe(false)
  })

  test('moveRoute reorders within the list and ignores a move off either end', () => {
    const routes = [route('a', 'opus'), route('b', 'opus'), route('c', 'opus')]
    expect(moveRoute(routes, 2, 0).map((r) => r.provider)).toEqual(['c', 'a', 'b'])
    expect(moveRoute(routes, 0, 3).map((r) => r.provider)).toEqual(['a', 'b', 'c'])
    expect(moveRoute(routes, 0, -1).map((r) => r.provider)).toEqual(['a', 'b', 'c'])
  })

  test('hasRoute is the duplicate the dialog refuses: same provider and tier', () => {
    const routes = [route('claude-code', 'sonnet')]
    expect(hasRoute(routes, 'claude-code', 'sonnet')).toBe(true)
    expect(hasRoute(routes, 'claude-code', 'opus')).toBe(false)
  })

  test('the footer counts every group, what is off and what cannot resolve', () => {
    const resolutions = resolutionIndex(view)
    const counts = mapCounts(draftOf(view), (r) => resolveRoute(r, resolutions, aliasIndex(null)))
    expect(counts).toEqual({ total: 3, off: 1, unresolved: 1 })
  })
})
