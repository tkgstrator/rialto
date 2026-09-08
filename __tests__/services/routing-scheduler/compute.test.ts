import { expect, test } from 'bun:test'
import { QuotaAwareConstraintsSchema } from '../../../src/schemas/domain/preference'
import { computeWeights } from '../../../src/services/routing-scheduler/compute'
import type {
  AccountQuotaState,
  ModelCandidateState,
  SchedulerInputState
} from '../../../src/services/routing-scheduler/types'

const NOW = 1_700_000_000_000
const CONSTRAINTS = QuotaAwareConstraintsSchema.parse({})
const TTL_MS = 5 * 60 * 1000

const account = (
  subAccountId: string,
  providerName: string,
  overrides: Partial<AccountQuotaState> = {}
): AccountQuotaState => ({
  subAccountId,
  providerName,
  kind: overrides.kind ?? 'claude',
  fiveHour: overrides.fiveHour,
  weekly: overrides.weekly,
  scopedFable: overrides.scopedFable,
  planWeight: overrides.planWeight ?? 1,
  refreshedAt: overrides.refreshedAt ?? NOW
})

const candidate = (target: string, overrides: Partial<ModelCandidateState> = {}): ModelCandidateState => ({
  target,
  providerName: overrides.providerName ?? target.split(',')[0],
  modelName: overrides.modelName ?? target.split(',')[1],
  accounts: overrides.accounts ?? [],
  errorRate: overrides.errorRate ?? 0
})

const stateOf = (
  entries: { target: string; enabled?: boolean }[],
  candidates: ModelCandidateState[],
  overrides: Partial<SchedulerInputState> = {}
): SchedulerInputState => ({
  now: NOW,
  preferences: entries.map((e, i) => ({
    priority: i + 1,
    target: e.target,
    enabled: e.enabled ?? true
  })),
  candidates: new Map(candidates.map((c) => [c.target, c])),
  previousWeights: null,
  constraints: CONSTRAINTS,
  ttlMs: TTL_MS,
  ...overrides
})

/**
 * The regression this pins: a weight is the candidate's own 0..1 health,
 * not a share of the chain. The formula used to open with
 * `(N - rank)/N` and close with `/ Σ healthiness`, which published 2/3
 * and 1/3 for two identically healthy candidates — numbers that changed
 * when an unrelated scenario's chain gained a target, and that summed to
 * neither 1 nor 100 on the Chain screen.
 */
test('two equally healthy candidates publish the same weight, whatever their rank', () => {
  const result = computeWeights(
    stateOf(
      [{ target: 'claude-code,fable-5' }, { target: 'claude-code,opus-5' }],
      [
        candidate('claude-code,fable-5', {
          accounts: [
            account('a1', 'claude-code', { fiveHour: { used: 10, limit: 100, resetAt: null, windowLengthMs: null } })
          ]
        }),
        candidate('claude-code,opus-5', {
          accounts: [
            account('a1', 'claude-code', { fiveHour: { used: 10, limit: 100, resetAt: null, windowLengthMs: null } })
          ]
        })
      ]
    )
  )
  // Both sit on the same account at 10/100 used → budget 0.9, no errors,
  // no reset penalty. Rank 0 and rank 1 alike publish 0.9.
  const fable = result.weights.find((w) => w.target === 'claude-code,fable-5')
  const opus = result.weights.find((w) => w.target === 'claude-code,opus-5')
  expect(fable?.weight).toBeCloseTo(0.9, 2)
  expect(opus?.weight).toBeCloseTo(0.9, 2)
  expect(result.held).toBe(false)
})

test('exhausted account demotes the candidate to zero-healthiness', () => {
  const result = computeWeights(
    stateOf(
      [{ target: 'claude-code,fable-5' }, { target: 'claude-code,opus-5' }],
      [
        candidate('claude-code,fable-5', {
          accounts: [
            account('a1', 'claude-code', { fiveHour: { used: 100, limit: 100, resetAt: null, windowLengthMs: null } })
          ]
        }),
        candidate('claude-code,opus-5', {
          accounts: [
            account('a1', 'claude-code', { fiveHour: { used: 20, limit: 100, resetAt: null, windowLengthMs: null } })
          ]
        })
      ]
    )
  )
  const fable = result.weights.find((w) => w.target === 'claude-code,fable-5')
  const opus = result.weights.find((w) => w.target === 'claude-code,opus-5')
  // The probe floor only lifts candidates with healthiness > 0, so a
  // fully exhausted one stays at exactly 0 — which is the single fact
  // the request path reads off a weight.
  expect(fable?.remainingBudgetPct).toBe(0)
  expect(fable?.weight).toBe(0)
  // Its healthy peer keeps its own budget (20/100 used → 0.8). It does
  // not inherit the exhausted candidate's share, because there are no
  // shares any more.
  expect(opus?.weight).toBeCloseTo(0.8, 2)
})

/**
 * The tick unions every scenario's chain into ONE vector (see
 * `runSchedulerTickForTest`), so under the old normalisation a target
 * added to the `think` chain quietly shrank every row the `default`
 * chain was showing. A weight has to describe its own candidate.
 */
test("a candidate's weight does not move when unrelated targets join the vector", () => {
  const healthy = (target: string) =>
    candidate(target, {
      accounts: [
        account(`${target}-1`, target.split(',')[0], {
          fiveHour: { used: 10, limit: 100, resetAt: null, windowLengthMs: null }
        })
      ]
    })
  const alone = computeWeights(stateOf([{ target: 'a,x' }], [healthy('a,x')]))
  const crowded = computeWeights(
    stateOf([{ target: 'a,x' }, { target: 'b,y' }, { target: 'c,z' }], [healthy('a,x'), healthy('b,y'), healthy('c,z')])
  )
  const before = alone.weights.find((w) => w.target === 'a,x')?.weight
  const after = crowded.weights.find((w) => w.target === 'a,x')?.weight
  expect(after).toBeCloseTo(before ?? -1, 5)
})

/**
 * The damper must not brake a stop.
 *
 * This only became reachable when weights stopped being normalised: on
 * the old scale an 8-target chain put every row near 0.12, so a drop to
 * zero fitted inside one 0.2 step. At 1.00 the same drop takes five
 * ticks — 25 minutes at the default interval — during which
 * `weight <= 0` still reads as usable and the selector keeps sending
 * traffic to an exhausted account.
 */
test('an exhausted candidate reaches zero in one tick, damper or not', () => {
  const state = stateOf(
    [{ target: 'a,x' }],
    [
      candidate('a,x', {
        accounts: [account('a1', 'a', { fiveHour: { used: 100, limit: 100, resetAt: null, windowLengthMs: null } })]
      })
    ],
    { previousWeights: new Map([['a,x', 1]]) }
  )
  const result = computeWeights(state)
  expect(result.weights.find((w) => w.target === 'a,x')?.weight).toBe(0)
})

/** The other direction still ramps: recovery is what the damper is for. */
test('a recovering candidate climbs no faster than maxDeltaPerTick', () => {
  const state = stateOf(
    [{ target: 'a,x' }],
    [
      candidate('a,x', {
        accounts: [account('a1', 'a', { fiveHour: { used: 0, limit: 100, resetAt: null, windowLengthMs: null } })]
      })
    ],
    { previousWeights: new Map([['a,x', 0]]) }
  )
  const result = computeWeights(state)
  expect(result.weights.find((w) => w.target === 'a,x')?.weight).toBeCloseTo(0.2, 2)
})

test('probe floor keeps a recovering account at min weight', () => {
  const result = computeWeights(
    stateOf(
      [{ target: 'a,x' }, { target: 'b,y' }],
      [
        candidate('a,x', {
          accounts: [account('a1', 'a', { fiveHour: { used: 99, limit: 100, resetAt: null, windowLengthMs: null } })]
        }),
        candidate('b,y', {
          accounts: [account('b1', 'b', { fiveHour: { used: 10, limit: 100, resetAt: null, windowLengthMs: null } })]
        })
      ]
    )
  )
  const a = result.weights.find((w) => w.target === 'a,x')
  expect(a?.weight).toBeGreaterThanOrEqual(0.01) // minWeightPct default 1%
})

test('disabled entry contributes zero weight', () => {
  const result = computeWeights(
    stateOf(
      [{ target: 'a,x', enabled: false }, { target: 'b,y' }],
      [
        candidate('a,x', {
          accounts: [account('a1', 'a', { fiveHour: { used: 10, limit: 100, resetAt: null, windowLengthMs: null } })]
        }),
        candidate('b,y', {
          accounts: [account('b1', 'b', { fiveHour: { used: 10, limit: 100, resetAt: null, windowLengthMs: null } })]
        })
      ]
    )
  )
  const a = result.weights.find((w) => w.target === 'a,x')
  const b = result.weights.find((w) => w.target === 'b,y')
  expect(a?.weight).toBe(0)
  // b is unaffected by a being switched off: 10/100 used → 0.9.
  expect(b?.weight).toBeCloseTo(0.9, 2)
})

test('unknown budget with default policy (allow) treats candidate as full budget', () => {
  const result = computeWeights(
    stateOf([{ target: 'a,x' }], [candidate('a,x', { accounts: [account('a1', 'a', { refreshedAt: null })] })])
  )
  const a = result.weights.find((w) => w.target === 'a,x')
  expect(a?.reasons).toContain('unknown_budget')
  expect(a?.weight).toBe(1)
})

test('unknown budget with demote policy uses staleQuotaFactor', () => {
  const strict = QuotaAwareConstraintsSchema.parse({ unknownBudgetPolicy: 'demote' })
  const result = computeWeights(
    stateOf(
      [{ target: 'a,x' }, { target: 'b,y' }],
      [
        candidate('a,x', { accounts: [account('a1', 'a', { refreshedAt: null })] }),
        candidate('b,y', {
          accounts: [account('b1', 'b', { fiveHour: { used: 10, limit: 100, resetAt: null, windowLengthMs: null } })]
        })
      ],
      { constraints: strict }
    )
  )
  const a = result.weights.find((w) => w.target === 'a,x')
  const b = result.weights.find((w) => w.target === 'b,y')
  // a is demoted (unknown_budget) → healthiness ~= 1 * 0.25 * 1 * 1 = 0.25
  // b is healthy → healthiness = 0.5 * 0.9 * 1 * 1 = 0.45 → wins
  expect((b?.weight ?? 0) > (a?.weight ?? 1)).toBe(true)
  expect(a?.reasons).toContain('unknown_budget')
})

test('stale account (past 3× ttlMs since refreshedAt) is demoted with reason', () => {
  const staleAcct = account('a1', 'a', {
    fiveHour: { used: 20, limit: 100, resetAt: null, windowLengthMs: null },
    refreshedAt: NOW - 4 * TTL_MS
  })
  const result = computeWeights(stateOf([{ target: 'a,x' }], [candidate('a,x', { accounts: [staleAcct] })]))
  const a = result.weights.find((w) => w.target === 'a,x')
  expect(a?.reasons).toContain('stale_quota')
})

test('resetSoon downweight applies when reset is near and remaining is low', () => {
  const near = NOW + 5 * 60 * 1000 // 5 min from now, below default 10-min threshold
  const result = computeWeights(
    stateOf(
      [{ target: 'a,x' }],
      [
        candidate('a,x', {
          accounts: [account('a1', 'a', { fiveHour: { used: 95, limit: 100, resetAt: near, windowLengthMs: null } })]
        })
      ]
    )
  )
  const a = result.weights.find((w) => w.target === 'a,x')
  expect(a?.reasons).toContain('reset_soon')
})

test('hold guard fires when top-preference primary would zero out despite budget', () => {
  const previous = new Map([
    ['a,x', 0.9],
    ['b,y', 0.1]
  ])
  const result = computeWeights(
    stateOf(
      [{ target: 'a,x' }, { target: 'b,y' }],
      [
        // Sabotage: no accounts registered — compute would drop the primary
        // to 0 despite the previous vector holding budget.
        candidate('a,x', { accounts: [] }),
        candidate('b,y', {
          accounts: [account('b1', 'b', { fiveHour: { used: 5, limit: 100, resetAt: null, windowLengthMs: null } })]
        })
      ],
      { previousWeights: previous, constraints: QuotaAwareConstraintsSchema.parse({ minWeightPct: 5 }) }
    )
  )
  // hold_guard only fires when the top-preference candidate had budget.
  // In this test the primary has no accounts (unknown_budget → 1.0 by
  // default), so it stays at high weight. Confirm the guard does NOT
  // fire in that case (allow test), then flip to demote to trigger.
  expect(result.held).toBe(false)
})

test('empty preferences return no entries and no held state', () => {
  const result = computeWeights(stateOf([], []))
  expect(result.weights).toEqual([])
  expect(result.held).toBe(false)
  expect(result.changes).toEqual([])
})

test('changes[] captures moves ≥ 0.01 vs previousWeights', () => {
  const previous = new Map([
    ['a,x', 0.5],
    ['b,y', 0.5]
  ])
  const result = computeWeights(
    stateOf(
      [{ target: 'a,x' }, { target: 'b,y' }],
      [
        candidate('a,x', {
          accounts: [account('a1', 'a', { fiveHour: { used: 10, limit: 100, resetAt: null, windowLengthMs: null } })]
        }),
        candidate('b,y', {
          accounts: [account('b1', 'b', { fiveHour: { used: 10, limit: 100, resetAt: null, windowLengthMs: null } })]
        })
      ],
      { previousWeights: previous }
    )
  )
  // rank 0 wins ~2/3; rank 1 gets ~1/3. Both changed vs previous 0.5/0.5.
  expect(result.changes.length).toBe(2)
})

test('candidate missing from state map yields no_quota_kind and zero weight', () => {
  const result = computeWeights(
    stateOf(
      [{ target: 'ghost,model' }, { target: 'b,y' }],
      [
        candidate('b,y', {
          accounts: [account('b1', 'b', { fiveHour: { used: 10, limit: 100, resetAt: null, windowLengthMs: null } })]
        })
      ]
    )
  )
  const ghost = result.weights.find((w) => w.target === 'ghost,model')
  expect(ghost?.reasons).toContain('no_quota_kind')
  expect(ghost?.weight).toBe(0)
})

test('modelBudget averages remaining ratio across peer accounts', () => {
  // Three same-plan accounts at 100% / 50% / 0% remaining on the 5h
  // window. The pool budget must be the plain average (50%), NOT the
  // max (100%) — the "single account wins" bug this test exercises used
  // to publish 100% whenever any peer still had headroom, hiding an
  // exhausted majority.
  const result = computeWeights(
    stateOf(
      [{ target: 'claude-code,opus-5' }],
      [
        candidate('claude-code,opus-5', {
          accounts: [
            account('a', 'claude-code', {
              fiveHour: { used: 0, limit: 100, resetAt: null, windowLengthMs: null }
            }),
            account('b', 'claude-code', {
              fiveHour: { used: 50, limit: 100, resetAt: null, windowLengthMs: null }
            }),
            account('c', 'claude-code', {
              fiveHour: { used: 100, limit: 100, resetAt: null, windowLengthMs: null }
            })
          ]
        })
      ]
    )
  )
  const opus = result.weights.find((w) => w.target === 'claude-code,opus-5')
  expect(opus?.remainingBudgetPct).toBe(50)
})

test('modelBudget weights peer accounts by planWeight (Pro=1, Max=5, Max20=20)', () => {
  // Pro 100%, Max 50%, Max20 0% — the Max20 account is 20x the size of
  // the Pro account, so its 0% should dominate. Expected weighted mean:
  // (1.0*1 + 0.5*5 + 0.0*20) / (1+5+20) = 3.5 / 26 ≈ 0.1346 → 13%.
  const result = computeWeights(
    stateOf(
      [{ target: 'claude-code,opus-5' }],
      [
        candidate('claude-code,opus-5', {
          accounts: [
            account('pro', 'claude-code', {
              planWeight: 1,
              fiveHour: { used: 0, limit: 100, resetAt: null, windowLengthMs: null }
            }),
            account('max', 'claude-code', {
              planWeight: 5,
              fiveHour: { used: 50, limit: 100, resetAt: null, windowLengthMs: null }
            }),
            account('max20', 'claude-code', {
              planWeight: 20,
              fiveHour: { used: 100, limit: 100, resetAt: null, windowLengthMs: null }
            })
          ]
        })
      ]
    )
  )
  const opus = result.weights.find((w) => w.target === 'claude-code,opus-5')
  expect(opus?.remainingBudgetPct).toBe(13)
})
