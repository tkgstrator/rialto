/**
 * The names a plan pill shows.
 *
 * Pinned because the stored strings cannot say it on their own — "max"
 * and "pro" are each two plans — and a pill that drops the multiplier
 * makes every meter beside it unreadable. The strings are the ones the
 * vendors actually send: Claude's organization_type plus rate_limit_tier,
 * Codex's chatgpt_plan_type / plan_type.
 */
import { describe, expect, test } from 'bun:test'
import { planCapacityWeight } from '../../src/shared/plan-capacity'
import { planLabel } from '../../src/shared/plan-label'

describe('planLabel — Claude', () => {
  test('Max takes its multiplier from the rate limit tier', () => {
    expect(planLabel('claude', 'claude_max', 'default_claude_max_20x')).toBe('Max 20x')
    expect(planLabel('claude', 'claude_max', 'default_claude_max_5x')).toBe('Max 5x')
  })

  test('a Max whose tier never arrived is shown as Max, not guessed at', () => {
    expect(planLabel('claude', 'claude_max', null)).toBe('Max')
  })

  test('Pro is the base plan and carries no multiplier', () => {
    expect(planLabel('claude', 'claude_pro', 'default_claude_pro')).toBe('Pro')
  })

  test('the tier alone is enough when the plan string is missing', () => {
    expect(planLabel('claude', null, 'default_claude_max_20x')).toBe('Max 20x')
  })
})

describe('planLabel — Codex', () => {
  test('prolite is Pro 5x and a bare pro is Pro 20x', () => {
    expect(planLabel('codex', 'prolite', null)).toBe('Pro 5x')
    expect(planLabel('codex', 'pro', null)).toBe('Pro 20x')
  })

  test('the vendor prefix a stored row carries is ignored', () => {
    expect(planLabel('codex', 'codex_pro', 'default')).toBe('Pro 20x')
  })

  test('Plus is the base plan', () => {
    expect(planLabel('codex', 'plus', null)).toBe('Plus')
  })

  test('a Pro that names its level takes it', () => {
    expect(planLabel('codex', 'pro_5x', null)).toBe('Pro 5x')
  })
})

describe('planLabel — anything else', () => {
  test('nothing reported is no name, not an empty pill', () => {
    expect(planLabel('claude', null, null)).toBeNull()
    expect(planLabel(null, null, null)).toBeNull()
  })

  test('an unknown plan reads as its own words', () => {
    expect(planLabel('codex', 'self_serve_business_usage_based', null)).toBe('Self Serve Business Usage Based')
    expect(planLabel(null, 'team_20x', null)).toBe('Team 20x')
  })

  test('"pro" is the top seat on Codex only', () => {
    expect(planLabel('claude', 'pro', null)).toBe('Pro')
    expect(planLabel(null, 'pro', null)).toBe('Pro')
  })
})

describe('planLabel agrees with planCapacityWeight', () => {
  // The pill and the scheduler read the same strings. A seat named 20x on
  // screen that the scheduler weighs as 5x is a misrouted request nobody
  // can see the cause of.
  const cases: [Parameters<typeof planLabel>, string, number][] = [
    [['claude', 'claude_max', 'default_claude_max_20x'], 'Max 20x', 20],
    [['claude', 'claude_max', 'default_claude_max_5x'], 'Max 5x', 5],
    [['claude', 'claude_pro', null], 'Pro', 1],
    [['codex', 'pro', null], 'Pro 20x', 20],
    [['codex', 'prolite', null], 'Pro 5x', 5],
    [['codex', 'plus', null], 'Plus', 1]
  ]
  for (const [args, name, weight] of cases) {
    test(`${name} weighs ${weight}`, () => {
      expect(planLabel(...args)).toBe(name)
      expect(planCapacityWeight(...args)).toBe(weight)
    })
  }
})
