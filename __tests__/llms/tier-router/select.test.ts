/**
 * The tier router's selector: which routes of one list can take one
 * request, the order pace puts them in, and what an empty answer means.
 *
 * The outcome is the part a client feels. Only quota or health earns the
 * exhausted outcome (429 or pass, per the profile); a list that is
 * configured but cannot take this request is refused (400), because
 * waiting would not help; nothing configured passes the request through.
 *
 * Pace only reorders what passed the gates: a surplus route (projected
 * under 60% at the reset) moves to the front, an over-pace one (over
 * 100%) to the back, and list order holds within each band.
 */

import { describe, expect, test } from 'bun:test'
import {
  PACE_OVER_PCT,
  PACE_SURPLUS_PCT,
  selectTierRoute,
  type TierCandidate,
  type TierSelectInput
} from '../../../src/llms/tier-router/select'
import { DEFAULT_CONSTRAINTS } from '../tier-fixture'

const candidate = (target: string | null, over: Partial<TierCandidate> = {}): TierCandidate => ({
  route: target === null ? 'x · sonnet' : target,
  target,
  targetTier: 'sonnet',
  enabled: true,
  targetEnabled: true,
  hostsWebSearch: true,
  contextWindow: 200_000,
  projectedPct: null,
  ...over
})

const select = (candidates: TierCandidate[], over: Partial<TierSelectInput> = {}) =>
  selectTierRoute({
    candidates,
    requestedTier: 'sonnet',
    constraints: DEFAULT_CONSTRAINTS,
    needsWebSearch: false,
    requestTokenCount: 1_000,
    isExhausted: () => false,
    health: () => ({ errorRate: 0, samples: 0 }),
    ...over
  })

// The order a selection hands the dispatcher: primary, then fallbacks.
const orderOf = (out: ReturnType<typeof select>): (string | null)[] => [out.primary, ...out.fallbacks]

// A route named by its target, on a given pace.
const paced = (target: string, projectedPct: number | null) => candidate(target, { projectedPct })

describe('selectTierRoute', () => {
  test('routes in list order: the first that passes is primary, the rest fall back', () => {
    const out = select([candidate('claude-code,claude-sonnet-5'), candidate('codex,gpt-5.5')])
    expect(out).toMatchObject({
      outcome: 'routed',
      primary: 'claude-code,claude-sonnet-5',
      fallbacks: ['codex,gpt-5.5'],
      paced: { promoted: [], steppedDown: [] }
    })
  })

  test('no routes, or only switched-off ones, pass the request through', () => {
    expect(select([]).outcome).toBe('passthrough')
    expect(select([candidate('a,b', { enabled: false }), candidate('c,d', { targetEnabled: false })]).outcome).toBe(
      'passthrough'
    )
  })

  test('exhaustion anywhere makes it the exhausted outcome, even beside a refusal', () => {
    const out = select([candidate('a,b'), candidate(null)], { isExhausted: (t) => t === 'a,b' })
    expect(out.outcome).toBe('exhausted')
    expect(out.skipped.map((s) => s.reason)).toEqual(['exhausted', 'alias_unset'])
  })

  test('an error rate counts only once it has enough samples', () => {
    const noisy = { health: () => ({ errorRate: 1, samples: 1 }) }
    expect(select([candidate('a,b')], noisy).outcome).toBe('routed')
    const failing = { health: () => ({ errorRate: 0.8, samples: 5 }) }
    expect(select([candidate('a,b')], failing).outcome).toBe('exhausted')
  })

  test('a configured list that cannot take this request is refused, with why', () => {
    const out = select([candidate(null), candidate('a,b', { hostsWebSearch: false })], { needsWebSearch: true })
    expect(out.outcome).toBe('refused')
    expect(out.refusal).toContain('no model aliased')
    expect(out.refusal).toContain('web_search')
  })

  test('a prompt bigger than every window is refused; an unknown window is trusted', () => {
    expect(select([candidate('a,b', { contextWindow: 500 })]).outcome).toBe('refused')
    expect(select([candidate('a,b', { contextWindow: null })]).outcome).toBe('routed')
  })

  test('web search only matters when the request carries the tool', () => {
    expect(select([candidate('a,b', { hostsWebSearch: false })]).outcome).toBe('routed')
  })

  test('a selection with no primary moved nothing', () => {
    const out = select([paced('a,b', 10)], { isExhausted: () => true })
    expect(out.outcome).toBe('exhausted')
    expect(out.paced).toEqual({ promoted: [], steppedDown: [] })
  })
})

describe('selectTierRoute: pace', () => {
  test('the bands are 60% and 100% of the budget at the reset', () => {
    expect(PACE_SURPLUS_PCT).toBe(60)
    expect(PACE_OVER_PCT).toBe(100)
  })

  test('a route with quota to spare moves to the front', () => {
    const out = select([paced('a,b', 80), paced('c,d', null), paced('e,f', 30)])
    expect(orderOf(out)).toEqual(['e,f', 'a,b', 'c,d'])
    expect(out.paced).toEqual({ promoted: ['e,f'], steppedDown: [] })
  })

  test('a route on course to run out moves to the back, so the one below it serves first', () => {
    const out = select([paced('a,b', 130), paced('c,d', 90), paced('e,f', null)])
    expect(orderOf(out)).toEqual(['c,d', 'e,f', 'a,b'])
    expect(out.paced).toEqual({ promoted: [], steppedDown: ['a,b'] })
  })

  test('surplus, then the rest, then over-pace, list order within each band', () => {
    const out = select([
      paced('over-1,m', 150),
      paced('even-1,m', 70),
      paced('surplus-1,m', 10),
      paced('over-2,m', 101),
      paced('even-2,m', null),
      paced('surplus-2,m', 59)
    ])
    expect(orderOf(out)).toEqual(['surplus-1,m', 'surplus-2,m', 'even-1,m', 'even-2,m', 'over-1,m', 'over-2,m'])
    expect(out.paced).toEqual({ promoted: ['surplus-1,m', 'surplus-2,m'], steppedDown: ['over-1,m', 'over-2,m'] })
  })

  test('every route over pace keeps list order: a projection alone never refuses', () => {
    const out = select([paced('a,b', 200), paced('c,d', 120), paced('e,f', 101)])
    expect(out.outcome).toBe('routed')
    expect(orderOf(out)).toEqual(['a,b', 'c,d', 'e,f'])
    expect(out.paced).toEqual({ promoted: [], steppedDown: [] })
  })

  test('every route with a surplus keeps list order too', () => {
    const out = select([paced('a,b', 50), paced('c,d', 0)])
    expect(orderOf(out)).toEqual(['a,b', 'c,d'])
    expect(out.paced).toEqual({ promoted: [], steppedDown: [] })
  })

  test('no reading is neutral: neither promoted nor stepped down', () => {
    const out = select([paced('a,b', null), paced('c,d', null)])
    expect(orderOf(out)).toEqual(['a,b', 'c,d'])
    expect(out.paced).toEqual({ promoted: [], steppedDown: [] })
  })

  test('the band edges are on pace: exactly 60% and exactly 100% keep their place', () => {
    const out = select([paced('a,b', 100), paced('c,d', 60), paced('e,f', null)])
    expect(orderOf(out)).toEqual(['a,b', 'c,d', 'e,f'])
    expect(out.paced).toEqual({ promoted: [], steppedDown: [] })
  })

  test('a surplus route already at the front, or an over-pace one already last, is not reported as moved', () => {
    const out = select([paced('a,b', 10), paced('c,d', 80), paced('e,f', 150)])
    expect(orderOf(out)).toEqual(['a,b', 'c,d', 'e,f'])
    expect(out.paced).toEqual({ promoted: [], steppedDown: [] })
  })

  test('pace orders only what passed the gates', () => {
    // A held route is skipped however much quota its pace says is left.
    const out = select([paced('e,f', 200), paced('a,b', 90), paced('c,d', 5)], {
      isExhausted: (t) => t === 'c,d'
    })
    expect(orderOf(out)).toEqual(['a,b', 'e,f'])
    expect(out.skipped).toEqual([{ route: 'c,d', reason: 'exhausted' }])
    expect(out.paced).toEqual({ promoted: [], steppedDown: ['e,f'] })
  })

  test('the moves are reported by route, not by target', () => {
    const out = select([
      candidate('claude-code,claude-fable-5', { route: 'claude-code · fable', projectedPct: 140 }),
      candidate('claude-code,claude-sonnet-5', { route: 'claude-code · sonnet', projectedPct: 20 })
    ])
    expect(out.paced).toEqual({ promoted: ['claude-code · sonnet'], steppedDown: ['claude-code · fable'] })
  })
})

describe('blocked escalation destinations', () => {
  const constraints = {
    ...DEFAULT_CONSTRAINTS,
    blockedEscalationTiers: ['opus', 'fable']
  } satisfies TierSelectInput['constraints']
  const routes = [
    candidate('a,fable', { targetTier: 'fable', projectedPct: 10 }),
    candidate('a,opus', { targetTier: 'opus' }),
    candidate('a,sonnet', { targetTier: 'sonnet' }),
    candidate('a,haiku', { targetTier: 'haiku' })
  ]

  test('Sonnet cannot escalate into blocked tiers, including surplus primary and fallbacks', () => {
    const out = select(routes, { constraints })
    expect(orderOf(out)).toEqual(['a,sonnet', 'a,haiku'])
    expect(out.skipped.map((entry) => entry.reason)).toEqual(['escalation_blocked', 'escalation_blocked'])
    expect(out.paced.promoted).toEqual([])
  })

  test('Haiku can still escalate to Sonnet', () => {
    expect(orderOf(select(routes, { constraints, requestedTier: 'haiku' }))).toEqual(['a,sonnet', 'a,haiku'])
  })

  test('same-tier requests and every demotion remain eligible even if all tiers are selected', () => {
    const allBlocked = {
      ...constraints,
      blockedEscalationTiers: ['fable', 'opus', 'sonnet', 'haiku']
    } satisfies TierSelectInput['constraints']
    expect(orderOf(select(routes, { constraints: allBlocked, requestedTier: 'fable' }))).toEqual([
      'a,fable',
      'a,opus',
      'a,sonnet',
      'a,haiku'
    ])
    expect(orderOf(select(routes, { constraints: allBlocked, requestedTier: 'opus' }))).toEqual([
      'a,opus',
      'a,sonnet',
      'a,haiku'
    ])
  })

  test('demotions can still be promoted by pace', () => {
    const out = select(
      [
        candidate('a,fable', { targetTier: 'fable', projectedPct: 120 }),
        candidate('a,opus', { targetTier: 'opus', projectedPct: 20 })
      ],
      { constraints, requestedTier: 'fable' }
    )
    expect(orderOf(out)).toEqual(['a,opus', 'a,fable'])
  })

  test('exhaustion does not reintroduce blocked escalation', () => {
    const out = select(routes, { constraints, isExhausted: () => true })
    expect(out).toMatchObject({ outcome: 'exhausted', primary: null, fallbacks: [] })
  })

  test('only blocked routes refuse instead of silently escalating', () => {
    const out = select(routes.slice(0, 2), { constraints })
    expect(out).toMatchObject({ outcome: 'refused', primary: null, fallbacks: [] })
    expect(out.refusal).toContain('forbids escalation')
  })

  test('an unknown caller tier and an empty restriction list preserve existing routing', () => {
    expect(select(routes, { constraints, requestedTier: undefined }).primary).toBe('a,fable')
    expect(select(routes).primary).toBe('a,fable')
  })
})
