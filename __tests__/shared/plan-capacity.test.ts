/**
 * The seat weights two sides now share.
 *
 * `planCapacityWeight` moved out of the sync service into `shared/` so the
 * Providers screen's Quota column and the routing scheduler's pool budget
 * cannot disagree about what a seat is worth. The mapping is pinned here
 * because both readers are far from it: a wrong weight shows up as a
 * plausible-looking percentage on one screen and a misrouted request on
 * the other, neither of which announces itself.
 *
 * The strings are the ones the two vendors actually store — Claude's
 * organization_type plus rate_limit_tier, Codex's chatgpt_plan_type.
 */
import { describe, expect, test } from 'bun:test'
import { planCapacityWeight } from '../../src/shared/plan-capacity'

describe('planCapacityWeight — Claude', () => {
  test('reads Max 20x off the rate limit tier, where it is the only signal', () => {
    // The plan string says only "max": 5x and 20x are indistinguishable
    // without the tier.
    expect(planCapacityWeight('claude', 'claude_max', 'default_claude_max_20x')).toBe(20)
  })

  test('a Max naming 5x is the 5x seat', () => {
    expect(planCapacityWeight('claude', 'claude_max', 'default_claude_max_5x')).toBe(5)
  })

  test('a Max whose tier never arrived falls to the floor of the Max range', () => {
    expect(planCapacityWeight('claude', 'claude_max', null)).toBe(5)
  })

  test('Pro is the unit', () => {
    expect(planCapacityWeight('claude', 'claude_pro', 'default_claude_pro')).toBe(1)
  })
})

describe('planCapacityWeight — Codex', () => {
  test('Plus is the unit', () => {
    expect(planCapacityWeight('codex', 'codex_plus', 'default')).toBe(1)
  })

  test('Pro is a Max-class seat, not the unit Claude Pro is', () => {
    // The same bare string means opposite ends of the range, which is why
    // the vendor has to be passed in.
    expect(planCapacityWeight('codex', 'pro', null)).toBe(5)
    expect(planCapacityWeight('claude', 'pro', null)).toBe(1)
  })

  test('a Pro that names its level takes it, the way Claude Max does', () => {
    expect(planCapacityWeight('codex', 'codex_pro_20x', null)).toBe(20)
    expect(planCapacityWeight('codex', 'codex_pro', 'default_20x')).toBe(20)
  })
})

describe('planCapacityWeight — unknown seats', () => {
  test('an account the collector has no plan for still weighs something', () => {
    expect(planCapacityWeight(null, null, null)).toBe(1)
  })

  test('a hand-added subscription provider is read on fragments alone', () => {
    // No vendor to interpret "pro" with, so it stays the unit — but an
    // explicit 20x is still an explicit 20x.
    expect(planCapacityWeight(null, 'pro', null)).toBe(1)
    expect(planCapacityWeight(null, 'team_20x', null)).toBe(20)
  })
})
