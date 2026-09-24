/**
 * The tier router's selector: which routes can take one request, and what
 * an empty answer means.
 *
 * The outcome is the part a client feels. Only quota or health earns the
 * exhausted outcome (429 or pass, per the profile); a map that is
 * configured but cannot take this request is refused (400), because
 * waiting would not help; nothing configured passes the request through.
 */

import { describe, expect, test } from 'bun:test'
import { selectTierRoute, type TierCandidate, type TierSelectInput } from '../../../src/llms/tier-router/select'

const candidate = (target: string | null, over: Partial<TierCandidate> = {}): TierCandidate => ({
  route: target === null ? 'x · sonnet' : target,
  target,
  enabled: true,
  targetEnabled: true,
  hostsWebSearch: true,
  contextWindow: 200_000,
  ...over
})

const select = (candidates: TierCandidate[], over: Partial<TierSelectInput> = {}) =>
  selectTierRoute({
    candidates,
    constraints: { exhaustedBehavior: '429', quotaSkipPct: 100, errorRateSkipPct: 0.5, minHealthSamples: 5 },
    needsWebSearch: false,
    requestTokenCount: 1_000,
    isExhausted: () => false,
    health: () => ({ errorRate: 0, samples: 0 }),
    ...over
  })

describe('selectTierRoute', () => {
  test('routes in map order: the first that passes is primary, the rest fall back', () => {
    const out = select([candidate('claude-code,claude-sonnet-5'), candidate('codex,gpt-5.5')])
    expect(out).toMatchObject({
      outcome: 'routed',
      primary: 'claude-code,claude-sonnet-5',
      fallbacks: ['codex,gpt-5.5']
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

  test('a configured map that cannot take this request is refused, with why', () => {
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
})
