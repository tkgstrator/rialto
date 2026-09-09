/**
 * Why the Routing screen's State column reads `unknown`.
 *
 * The column is drawn from the scheduler's published weights. There used
 * to be two independent ways there could be none — the scheduler never
 * ticking (it only ran for quota-aware selection, so under the rules
 * selector there was no snapshot at all), and it ticking with nothing to
 * score. The first is gone with the selector that caused it: the
 * scheduler always runs now.
 *
 * What is left is the second, and it is the one that mattered: the
 * weights are built entirely from `RouterPreferenceEntry` rows, so an
 * install with no chain configured publishes an empty snapshot. Told
 * apart from a cold boot, which resolves within a tick.
 */

import { describe, expect, test } from 'bun:test'
import { schedulerScoredNothing } from '../../src/components/rialto/routing/derive'
import type { RoutingSchedulerStateResponse, RoutingSchedulerWeightEntry } from '../../src/lib/api-types'

const snapshot = (over: Partial<RoutingSchedulerStateResponse>): RoutingSchedulerStateResponse => ({
  tickAt: null,
  tickCount: 0,
  consecutiveFailures: 0,
  degraded: false,
  weights: [],
  accounts: [],
  soonestResetAt: null,
  recentChanges: [],
  ...over
})

describe('schedulerScoredNothing', () => {
  test('a tick that published no weights has nothing to score', () => {
    // The install this was found on: mode could be turned on and the
    // column would still say unknown, because no preference entry exists.
    expect(schedulerScoredNothing(snapshot({ tickAt: '2026-09-01T22:00:00Z', weights: [] }))).toBe(true)
  })

  test('a cold boot is not the same claim — it resolves within a tick', () => {
    expect(schedulerScoredNothing(snapshot({ tickAt: null, weights: [] }))).toBe(false)
  })

  test('no snapshot at all says nothing either way', () => {
    expect(schedulerScoredNothing(null)).toBe(false)
  })

  test('a tick that scored something is not it', () => {
    const entry: RoutingSchedulerWeightEntry = {
      target: 'anthropic,claude-opus-5',
      weight: 1,
      healthiness: 1,
      remainingBudgetPct: null,
      earliestResetAt: null,
      reasons: ['ok']
    }
    const scored = snapshot({ tickAt: '2026-09-01T22:00:00Z', weights: [entry] })
    expect(schedulerScoredNothing(scored)).toBe(false)
  })
})
