/**
 * `quotaSkipPct` on the request path.
 *
 * The constraint used to be stored and shown on the Routing screen while
 * nothing read it: the selector skipped only targets whose snapshot weight
 * had dropped to zero. It now also skips a target whose known budget is
 * used at or past the threshold. No database: the profile is passed in and
 * the snapshot is published directly.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolveQuotaAwareSelection } from '../../../src/llms/quota-router/runtime'
import type { RouterPreferenceEntry, RouterPreferenceProfile } from '../../../src/schemas/domain/preference'
import { __resetSchedulerStateForTest, publishSnapshot } from '../../../src/services/routing-scheduler/state'
import type { WeightEntry } from '../../../src/services/routing-scheduler/types'

const weightOf = (target: string, weight: number, remainingBudgetPct: number | null): WeightEntry => ({
  target,
  weight,
  healthiness: weight,
  remainingBudgetPct,
  earliestResetAt: null,
  reasons: [],
  paceRatio: null,
  windowElapsedRatio: null,
  contextWindow: null
})

const seedSnapshot = (entries: readonly WeightEntry[]): void => {
  publishSnapshot({
    tickAt: Date.now(),
    tickCount: 1,
    consecutiveFailures: 0,
    degraded: false,
    weights: new Map(entries.map((e) => [e.target, e])),
    accounts: [],
    soonestResetAt: null
  })
}

const entry = (priority: number, target: string): RouterPreferenceEntry => ({ priority, target, enabled: true })

const emptyPair = (): { agent: RouterPreferenceEntry[]; subagent: RouterPreferenceEntry[] } => ({
  agent: [],
  subagent: []
})

const profileWith = (
  agent: RouterPreferenceEntry[],
  constraints: RouterPreferenceProfile['constraints']
): RouterPreferenceProfile => ({
  entriesByScenario: {
    default: { agent, subagent: [] },
    think: emptyPair(),
    longContext: emptyPair(),
    webSearch: emptyPair(),
    image: emptyPair()
  },
  constraints
})

const primaryOf = async (profile: RouterPreferenceProfile): Promise<string | null> => {
  const out = await resolveQuotaAwareSelection({
    requestedModel: undefined,
    isSubagent: false,
    scenario: 'default',
    profile
  })
  return out.selection.primary
}

const OPUS = 'claude-code,claude-opus-5'
const SONNET = 'claude-code,claude-sonnet-5'
const CHAIN = [entry(1, OPUS), entry(2, SONNET)]

describe('quotaSkipPct', () => {
  beforeEach(() => __resetSchedulerStateForTest())
  afterEach(() => __resetSchedulerStateForTest())

  test('at the default of 100, a nearly spent budget is still served', async () => {
    seedSnapshot([weightOf(OPUS, 0.2, 5), weightOf(SONNET, 0.8, 60)])
    expect(await primaryOf(profileWith(CHAIN, null))).toBe(OPUS)
  })

  test('a budget used past the threshold is skipped for the next entry', async () => {
    seedSnapshot([weightOf(OPUS, 0.2, 5), weightOf(SONNET, 0.8, 60)])
    expect(await primaryOf(profileWith(CHAIN, { quotaSkipPct: 90 }))).toBe(SONNET)
  })

  test('a budget used exactly at the threshold is skipped too', async () => {
    seedSnapshot([weightOf(OPUS, 0.5, 10), weightOf(SONNET, 0.8, 60)])
    expect(await primaryOf(profileWith(CHAIN, { quotaSkipPct: 90 }))).toBe(SONNET)
  })

  test('a target with no known budget is never skipped on usage', async () => {
    const terra = 'openai,gpt-5.6-terra'
    seedSnapshot([weightOf(terra, 0.9, null)])
    expect(await primaryOf(profileWith([entry(1, terra)], { quotaSkipPct: 0 }))).toBe(terra)
  })

  test('a zero weight is still skipped, whatever the threshold', async () => {
    seedSnapshot([weightOf(OPUS, 0, 40), weightOf(SONNET, 0.8, 60)])
    expect(await primaryOf(profileWith(CHAIN, null))).toBe(SONNET)
  })
})
