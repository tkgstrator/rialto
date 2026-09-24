import { describe, expect, test } from 'bun:test'
import { selectByPreference } from '../../../src/llms/quota-router/selection'
import type { PreferenceConstraints, RouterPreferenceEntry } from '../../../src/schemas/domain/preference'

// Strict tier constraint: both directional gates OFF, so only same-tier
// candidates match the requested tier. Replaces the pre-Phase 2h
// per-tier `sonnetTierRespect` / `haikuTierRespect` design.
const CONSTRAINTS_STRICT: PreferenceConstraints = {
  allowEscalation: false,
  allowDemotion: false,
  quotaSkipPct: 100,
  errorRateSkipPct: 0.5,
  minHealthSamples: 5
}

// Loose tier constraint: both directional gates ON, tier becomes a
// hint (every candidate matches). Same as the schema defaults.
const CONSTRAINTS_LOOSE: PreferenceConstraints = {
  ...CONSTRAINTS_STRICT,
  allowEscalation: true,
  allowDemotion: true
}

const entry = (
  priority: number,
  target: string,
  overrides: Partial<RouterPreferenceEntry> = {}
): RouterPreferenceEntry => ({
  priority,
  target,
  enabled: overrides.enabled ?? true,
  allowEscalation: overrides.allowEscalation,
  allowDemotion: overrides.allowDemotion
})

const ALL_HEALTHY: Pick<Parameters<typeof selectByPreference>[0], 'isExhausted' | 'errorRate'> = {
  isExhausted: () => false,
  errorRate: () => 0
}

test('picks the first passing entry as primary and rest as fallbacks', () => {
  const result = selectByPreference({
    entries: [
      entry(1, 'claude-code,claude-fable-5'),
      entry(2, 'claude-code,claude-opus-5'),
      entry(3, 'claude-code,claude-sonnet-5')
    ],
    constraints: CONSTRAINTS_STRICT,
    requestedTier: undefined,
    isSubagent: false,
    ...ALL_HEALTHY
  })
  expect(result.primary).toBe('claude-code,claude-fable-5')
  expect(result.fallbacks).toEqual(['claude-code,claude-opus-5', 'claude-code,claude-sonnet-5'])
  expect(result.matched).toBe(true)
})

test('skips disabled entries and records the reason', () => {
  const result = selectByPreference({
    entries: [entry(1, 'claude-code,claude-fable-5', { enabled: false }), entry(2, 'claude-code,claude-opus-5')],
    constraints: CONSTRAINTS_STRICT,
    requestedTier: undefined,
    isSubagent: false,
    ...ALL_HEALTHY
  })
  expect(result.primary).toBe('claude-code,claude-opus-5')
  expect(result.skipped).toContainEqual({ target: 'claude-code,claude-fable-5', reason: 'disabled' })
})

test('sonnet request with both directional gates OFF stays on sonnet-tier candidates', () => {
  // fable and opus are ABOVE sonnet → escalation → blocked
  // haiku would be BELOW sonnet → demotion → blocked
  // only sonnet passes.
  const result = selectByPreference({
    entries: [
      entry(1, 'claude-code,claude-fable-5'),
      entry(2, 'claude-code,claude-opus-5'),
      entry(3, 'claude-code,claude-sonnet-5')
    ],
    constraints: CONSTRAINTS_STRICT,
    requestedTier: 'sonnet',
    isSubagent: false,
    ...ALL_HEALTHY
  })
  expect(result.primary).toBe('claude-code,claude-sonnet-5')
  expect(result.skipped.map((s) => s.reason)).toEqual(['tier_mismatch', 'tier_mismatch'])
})

test('sonnet request with both directional gates ON walks the full chain', () => {
  const result = selectByPreference({
    entries: [
      entry(1, 'claude-code,claude-fable-5'),
      entry(2, 'claude-code,claude-opus-5'),
      entry(3, 'claude-code,claude-sonnet-5')
    ],
    constraints: CONSTRAINTS_LOOSE,
    requestedTier: 'sonnet',
    isSubagent: false,
    ...ALL_HEALTHY
  })
  expect(result.primary).toBe('claude-code,claude-fable-5')
  expect(result.skipped).toEqual([])
})

test('sonnet request with only allowEscalation on: fable/opus in, haiku out', () => {
  // allowEscalation: true → upper-tier candidates admissible
  // allowDemotion: false → lower-tier candidates blocked
  const result = selectByPreference({
    entries: [
      entry(1, 'claude-code,claude-haiku-4-5'),
      entry(2, 'claude-code,claude-sonnet-5'),
      entry(3, 'claude-code,claude-opus-5')
    ],
    constraints: { ...CONSTRAINTS_STRICT, allowEscalation: true, allowDemotion: false },
    requestedTier: 'sonnet',
    isSubagent: false,
    ...ALL_HEALTHY
  })
  expect(result.primary).toBe('claude-code,claude-sonnet-5')
  // haiku demotion blocked; sonnet + opus admissible (sonnet earlier in
  // the chain wins, opus becomes a fallback).
  expect(result.fallbacks).toEqual(['claude-code,claude-opus-5'])
  expect(result.skipped.map((s) => s.reason)).toEqual(['tier_mismatch'])
})

test('sonnet request with only allowDemotion on: haiku in, fable/opus out', () => {
  const result = selectByPreference({
    entries: [
      entry(1, 'claude-code,claude-opus-5'),
      entry(2, 'claude-code,claude-sonnet-5'),
      entry(3, 'claude-code,claude-haiku-4-5')
    ],
    constraints: { ...CONSTRAINTS_STRICT, allowEscalation: false, allowDemotion: true },
    requestedTier: 'sonnet',
    isSubagent: false,
    ...ALL_HEALTHY
  })
  // opus escalation blocked; sonnet + haiku pass.
  expect(result.primary).toBe('claude-code,claude-sonnet-5')
  expect(result.fallbacks).toEqual(['claude-code,claude-haiku-4-5'])
  expect(result.skipped.map((s) => s.reason)).toEqual(['tier_mismatch'])
})

test('per-entry allowEscalation=false blocks a candidate even when the global gate allows it', () => {
  // Global allows escalation, but this single Fable row opts out —
  // request sonnet, fable is escalation → blocked for THIS row only.
  const result = selectByPreference({
    entries: [
      entry(1, 'claude-code,claude-fable-5', { allowEscalation: false }),
      entry(2, 'claude-code,claude-opus-5'),
      entry(3, 'claude-code,claude-sonnet-5')
    ],
    constraints: CONSTRAINTS_LOOSE,
    requestedTier: 'sonnet',
    isSubagent: false,
    ...ALL_HEALTHY
  })
  // Fable blocked by its own flag; opus still admissible via the global.
  expect(result.primary).toBe('claude-code,claude-opus-5')
  expect(result.skipped).toContainEqual({ target: 'claude-code,claude-fable-5', reason: 'tier_mismatch' })
})

test('per-entry allowEscalation=true admits a candidate even when the global gate blocks it', () => {
  // Global forbids escalation; this Opus row opts in — request sonnet,
  // opus is escalation → admissible for THIS row only.
  const result = selectByPreference({
    entries: [
      entry(1, 'claude-code,claude-fable-5'),
      entry(2, 'claude-code,claude-opus-5', { allowEscalation: true }),
      entry(3, 'claude-code,claude-sonnet-5')
    ],
    constraints: CONSTRAINTS_STRICT,
    requestedTier: 'sonnet',
    isSubagent: false,
    ...ALL_HEALTHY
  })
  // Fable still blocked (no per-entry override); Opus in via its flag.
  expect(result.primary).toBe('claude-code,claude-opus-5')
  expect(result.skipped).toContainEqual({ target: 'claude-code,claude-fable-5', reason: 'tier_mismatch' })
})

test('per-entry allowDemotion overrides the global demotion gate', () => {
  // Global forbids demotion; the Haiku row opts in.
  const result = selectByPreference({
    entries: [
      entry(1, 'claude-code,claude-sonnet-5'),
      entry(2, 'claude-code,claude-haiku-4-5', { allowDemotion: true })
    ],
    constraints: CONSTRAINTS_STRICT,
    requestedTier: 'sonnet',
    isSubagent: false,
    ...ALL_HEALTHY
  })
  expect(result.primary).toBe('claude-code,claude-sonnet-5')
  expect(result.fallbacks).toEqual(['claude-code,claude-haiku-4-5'])
})

test('directional gates apply symmetrically to any requested tier (haiku request)', () => {
  const result = selectByPreference({
    entries: [
      entry(1, 'claude-code,claude-fable-5'),
      entry(2, 'claude-code,claude-opus-5'),
      entry(3, 'claude-code,claude-sonnet-5'),
      entry(4, 'claude-code,claude-haiku-4-5')
    ],
    constraints: CONSTRAINTS_STRICT,
    requestedTier: 'haiku',
    isSubagent: false,
    ...ALL_HEALTHY
  })
  // Every non-haiku candidate is escalation from haiku → blocked.
  expect(result.primary).toBe('claude-code,claude-haiku-4-5')
})

test('exhausted candidates are skipped and demoted', () => {
  const result = selectByPreference({
    entries: [entry(1, 'claude-code,claude-fable-5'), entry(2, 'claude-code,claude-opus-5')],
    constraints: CONSTRAINTS_STRICT,
    requestedTier: undefined,
    isSubagent: false,
    isExhausted: (t) => t === 'claude-code,claude-fable-5',
    errorRate: () => 0
  })
  expect(result.primary).toBe('claude-code,claude-opus-5')
  expect(result.skipped).toContainEqual({ target: 'claude-code,claude-fable-5', reason: 'exhausted' })
})

test('error rate at or above errorRateSkipPct skips the candidate', () => {
  const result = selectByPreference({
    entries: [entry(1, 'claude-code,claude-fable-5'), entry(2, 'claude-code,claude-opus-5')],
    constraints: CONSTRAINTS_STRICT,
    requestedTier: undefined,
    isSubagent: false,
    isExhausted: () => false,
    errorRate: (t) => (t === 'claude-code,claude-fable-5' ? 0.6 : 0)
  })
  expect(result.primary).toBe('claude-code,claude-opus-5')
  expect(result.skipped).toContainEqual({ target: 'claude-code,claude-fable-5', reason: 'error_rate' })
})

test('error rate exactly at threshold still skips (>= comparison)', () => {
  const result = selectByPreference({
    entries: [entry(1, 'claude-code,claude-fable-5')],
    constraints: CONSTRAINTS_STRICT,
    requestedTier: undefined,
    isSubagent: false,
    isExhausted: () => false,
    errorRate: () => 0.5
  })
  expect(result.primary).toBeNull()
  expect(result.matched).toBe(false)
})

test('all-fail returns primary=null and matched=false', () => {
  const result = selectByPreference({
    entries: [entry(1, 'claude-code,claude-fable-5'), entry(2, 'claude-code,claude-opus-5')],
    constraints: CONSTRAINTS_STRICT,
    requestedTier: undefined,
    isSubagent: false,
    isExhausted: () => true,
    errorRate: () => 0
  })
  expect(result.primary).toBeNull()
  expect(result.fallbacks).toEqual([])
  expect(result.matched).toBe(false)
})

test('malformed target is admissible (unknown tier falls through the tier gate)', () => {
  // Unknown-tier candidates can't be classified as escalation or
  // demotion — the alternative would evict every third-party model
  // the operator explicitly configured. So they pass the gate.
  const result = selectByPreference({
    entries: [entry(1, 'malformed'), entry(2, 'claude-code,claude-sonnet-5')],
    constraints: CONSTRAINTS_STRICT,
    requestedTier: 'sonnet',
    isSubagent: false,
    ...ALL_HEALTHY
  })
  expect(result.primary).toBe('malformed')
})

test('empty chain returns no primary', () => {
  const result = selectByPreference({
    entries: [],
    constraints: CONSTRAINTS_STRICT,
    requestedTier: undefined,
    isSubagent: false,
    ...ALL_HEALTHY
  })
  expect(result.primary).toBeNull()
  expect(result.matched).toBe(false)
})

test('opus request with strict tier: sonnet is demotion, blocked; sonnet in loose passes', () => {
  const strict = selectByPreference({
    entries: [entry(1, 'claude-code,claude-sonnet-5'), entry(2, 'claude-code,claude-opus-5')],
    constraints: CONSTRAINTS_STRICT,
    requestedTier: 'opus',
    isSubagent: false,
    ...ALL_HEALTHY
  })
  expect(strict.primary).toBe('claude-code,claude-opus-5')
  const loose = selectByPreference({
    entries: [entry(1, 'claude-code,claude-sonnet-5'), entry(2, 'claude-code,claude-opus-5')],
    constraints: CONSTRAINTS_LOOSE,
    requestedTier: 'opus',
    isSubagent: false,
    ...ALL_HEALTHY
  })
  expect(loose.primary).toBe('claude-code,claude-sonnet-5')
})

/**
 * Nearest-tier retry. The directional gates are a preference about which
 * tier serves a request; when they alone leave nothing, the refused
 * candidates get a second pass, nearest tier first and the cheaper side
 * before the pricier one. `tierFallback: 'refuse'` keeps them hard.
 */
describe('nearest-tier retry', () => {
  // "down only" on the Routing screen: escalation off, demotion on.
  const DOWN_ONLY: PreferenceConstraints = { ...CONSTRAINTS_STRICT, allowDemotion: true }

  test('a haiku request on a sonnet-only chain with escalation off is served by sonnet', () => {
    const result = selectByPreference({
      entries: [entry(1, 'claude-code,claude-sonnet-5')],
      constraints: DOWN_ONLY,
      requestedTier: 'haiku',
      isSubagent: false,
      ...ALL_HEALTHY
    })
    expect(result.primary).toBe('claude-code,claude-sonnet-5')
    expect(result.substituted).toBe(true)
    // The substitute passed, so its tier_mismatch no longer describes it.
    expect(result.skipped).toEqual([])
  })

  test("tierFallback 'refuse' keeps the gate hard", () => {
    const result = selectByPreference({
      entries: [entry(1, 'claude-code,claude-sonnet-5')],
      constraints: { ...DOWN_ONLY, tierFallback: 'refuse' },
      requestedTier: 'haiku',
      isSubagent: false,
      ...ALL_HEALTHY
    })
    expect(result.primary).toBeNull()
    expect(result.substituted).toBe(false)
    expect(result.skipped).toEqual([{ target: 'claude-code,claude-sonnet-5', reason: 'tier_mismatch' }])
  })

  test('equally distant tiers: the cheaper one comes first, then chain order', () => {
    const result = selectByPreference({
      entries: [entry(1, 'claude-code,claude-opus-5'), entry(2, 'claude-code,claude-haiku-4-5')],
      constraints: CONSTRAINTS_STRICT,
      requestedTier: 'sonnet',
      isSubagent: false,
      ...ALL_HEALTHY
    })
    expect(result.primary).toBe('claude-code,claude-haiku-4-5')
    expect(result.fallbacks).toEqual(['claude-code,claude-opus-5'])
  })

  test('nearer tiers come before farther ones', () => {
    const result = selectByPreference({
      entries: [entry(1, 'claude-code,claude-fable-5'), entry(2, 'claude-code,claude-sonnet-5')],
      constraints: DOWN_ONLY,
      requestedTier: 'haiku',
      isSubagent: false,
      ...ALL_HEALTHY
    })
    expect(result.primary).toBe('claude-code,claude-sonnet-5')
    expect(result.fallbacks).toEqual(['claude-code,claude-fable-5'])
  })

  test('a substitute is still held to the exhaustion gate, and reports it', () => {
    const result = selectByPreference({
      entries: [entry(1, 'claude-code,claude-sonnet-5')],
      constraints: DOWN_ONLY,
      requestedTier: 'haiku',
      isSubagent: false,
      isExhausted: () => true,
      errorRate: () => 0
    })
    expect(result.primary).toBeNull()
    expect(result.skipped).toEqual([{ target: 'claude-code,claude-sonnet-5', reason: 'exhausted' }])
  })

  test('no retry while a candidate of an allowed tier passes', () => {
    const result = selectByPreference({
      entries: [entry(1, 'claude-code,claude-sonnet-5'), entry(2, 'claude-code,claude-haiku-4-5')],
      constraints: DOWN_ONLY,
      requestedTier: 'haiku',
      isSubagent: false,
      ...ALL_HEALTHY
    })
    expect(result.primary).toBe('claude-code,claude-haiku-4-5')
    expect(result.fallbacks).toEqual([])
    expect(result.substituted).toBe(false)
  })
})
