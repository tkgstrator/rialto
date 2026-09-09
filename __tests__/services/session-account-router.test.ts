/**
 * Tests for session-account-router — the per-session account picker.
 *
 * Both data sources the picker depends on are mocked so the suite never
 * touches the DB or the network:
 *   - `getSubAccountTokensForKind` lists the enabled accounts of a kind
 *     (would otherwise need the DB + token decryption).
 *   - `getPerAccountUsage` returns the per-account hard-limit window
 *     state the picker consults (would otherwise need the
 *     SubAccountUsage table).
 *
 * Tests pin the clock against deterministic resetAt values via the
 * `NOW` constant so the time terms don't drift.
 */

import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { clearAccountExhaustion, markAccountExhausted } from '../../src/services/failover-state'
import type { SubAccountTokenInfo } from '../../src/services/subscription-account-sync-service'

// Metric strings duplicated here to avoid `await import('subaccount-usage-store')`
// inside the mock factory below — re-importing the same module being
// mocked causes the factory to recurse and the test runner to spin.
type Metric =
  | 'claude.five_hour'
  | 'claude.seven_day'
  | 'claude.seven_day_sonnet'
  | 'claude.seven_day_opus'
  | 'claude.seven_day_scoped.fable'
  | 'codex.primary'
  | 'codex.secondary'

// The per-model weekly window Anthropic actually reports today. Kept as
// a named constant because the router recognises it by prefix, not by a
// fixed key.
const SCOPED_FABLE: Metric = 'claude.seven_day_scoped.fable'

// Requested-model ids. Per-model windows bind only for the model the
// request asks for, so a test that seeds one has to say which model it
// is routing.
const OPUS_MODEL = 'claude-opus-4-5'
const FABLE_MODEL = 'claude-fable-5-1'
const SONNET_MODEL = 'claude-sonnet-5'
const CLAUDE_METRICS = {
  five_hour: 'claude.five_hour' as Metric,
  seven_day: 'claude.seven_day' as Metric,
  seven_day_sonnet: 'claude.seven_day_sonnet' as Metric,
  seven_day_opus: 'claude.seven_day_opus' as Metric
}
type AccountUsageMap = Map<Metric, { percent: number; resetAt: Date | null }>

// Mutable lists / maps the mocks return. Tests reset and reseed these
// before each invocation of the router.
let claudeAccounts: SubAccountTokenInfo[] = []
let perAccountUsage: Map<string, AccountUsageMap> = new Map()

// Capture the real namespace BEFORE replacing it. mock.module swaps the entry
// for the whole `bun test` process, not just this file, so a factory that
// returns only the function under test leaves every later test file importing
// another export of the same barrel dying on
// `SyntaxError: Export named '...' not found`. Which files that hits depends on
// the order bun happens to run them in, which is why it reproduces in CI and
// not always locally. Spreading the real module keeps the rest of the surface.
// The import has to resolve out here — doing it inside the factory re-enters
// the module being mocked and spins the runner.
const realSyncService = await import('../../src/services/subscription-account-sync-service')

mock.module('../../src/services/subscription-account-sync-service', () => ({
  ...realSyncService,
  getSubAccountTokensForKind: async (kind: 'claude' | 'codex'): Promise<SubAccountTokenInfo[]> =>
    kind === 'claude' ? claudeAccounts : []
}))

const realUsageStore = await import('../../src/services/subaccount-usage-store')

mock.module('../../src/services/subaccount-usage-store', () => ({
  ...realUsageStore,
  CLAUDE_METRICS,
  CODEX_METRICS: { primary: 'codex.primary', secondary: 'codex.secondary' },
  getPerAccountUsage: async (subAccountIds: string[]): Promise<Map<string, AccountUsageMap>> => {
    const out = new Map<string, AccountUsageMap>(subAccountIds.map((id) => [id, perAccountUsage.get(id) ?? new Map()]))
    return out
  }
}))

// Imported after the mocks are registered so the router binds to the stubs.
const { resolveAccountForSession, getActiveAccountForSession, releaseAccountForSession } = await import(
  '../../src/services/session-account-router'
)

// A 7-day window in ms and a fixed `now` sitting exactly halfway through a
// window whose reset is a further half-window away => linear target 50%.
const SEVEN_DAY_MS = 7 * 86_400_000
const NOW = 1_000_000_000_000
const HALFWAY_RESET = new Date(NOW + SEVEN_DAY_MS / 2)

const account = (subAccountId: string): SubAccountTokenInfo => ({
  subAccountId,
  displayName: subAccountId,
  accessToken: `token-${subAccountId}`,
  refreshToken: null,
  accountId: null,
  expiresAt: null
})

// Build a synthetic per-account usage map. By default every window
// resets at HALFWAY_RESET and lives below the hard-limit threshold so
// the picker passes the gate — individual tests override specific
// windows to exercise the branches.
const usage = (overrides: Partial<Record<Metric, { percent: number; resetAt: Date | null }>>): AccountUsageMap => {
  const m: AccountUsageMap = new Map()
  m.set(CLAUDE_METRICS.five_hour, { percent: 10, resetAt: HALFWAY_RESET })
  m.set(CLAUDE_METRICS.seven_day, { percent: 40, resetAt: HALFWAY_RESET })
  m.set(CLAUDE_METRICS.seven_day_sonnet, { percent: 30, resetAt: HALFWAY_RESET })
  m.set(CLAUDE_METRICS.seven_day_opus, { percent: 50, resetAt: HALFWAY_RESET })
  for (const [k, v] of Object.entries(overrides)) m.set(k as Metric, v as { percent: number; resetAt: Date | null })
  return m
}

beforeEach(() => {
  claudeAccounts = []
  perAccountUsage = new Map()
  clearAccountExhaustion('a1')
  clearAccountExhaustion('a2')
  clearAccountExhaustion('a3')
  clearAccountExhaustion('solo')
})

afterEach(() => {
  clearAccountExhaustion('a1')
  clearAccountExhaustion('a2')
  clearAccountExhaustion('a3')
  clearAccountExhaustion('solo')
})

test('returns null when no accounts exist', async () => {
  expect(await resolveAccountForSession('s-none', 'claude', undefined, NOW)).toBeNull()
})

test('returns the only account without consulting usage', async () => {
  claudeAccounts = [account('solo')]
  const picked = await resolveAccountForSession('s-solo', 'claude', undefined, NOW)
  expect(picked?.subAccountId).toBe('solo')
})

test('picks the account with the highest required burn rate (same resetAt)', async () => {
  // Same resetAt: timeRemaining cancels, so larger pctRemaining wins.
  // a1 opus 20% (pctRemaining 80) beats a2 opus 45% (pctRemaining 55).
  claudeAccounts = [account('a1'), account('a2')]
  perAccountUsage.set('a1', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 20, resetAt: HALFWAY_RESET } }))
  perAccountUsage.set('a2', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 45, resetAt: HALFWAY_RESET } }))
  const picked = await resolveAccountForSession('s-opus', 'claude', OPUS_MODEL, NOW)
  expect(picked?.subAccountId).toBe('a1')
})

test('picks the nearer-reset account when both have the same usage', async () => {
  // Same pctRemaining: smaller timeRemainingMs wins. a1 resets in 1
  // day, a2 in 6 days — a1 must burn faster, so a1 is picked.
  const nearReset = new Date(NOW + 1 * 86_400_000)
  const farReset = new Date(NOW + 6 * 86_400_000)
  claudeAccounts = [account('a1'), account('a2')]
  perAccountUsage.set('a1', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 50, resetAt: nearReset } }))
  perAccountUsage.set('a2', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 50, resetAt: farReset } }))
  const picked = await resolveAccountForSession('s-near', 'claude', OPUS_MODEL, NOW)
  expect(picked?.subAccountId).toBe('a1')
})

test('an account with no usage rows ranks BELOW one with a healthy reading', async () => {
  // a1 has DB usage with a finite burn rate; a2 has no row at all.
  // "No reading" must not outrank real data — as +Infinity did, which
  // let one unpolled account monopolise the pool forever.
  claudeAccounts = [account('a1'), account('a2')]
  perAccountUsage.set('a1', usage({ [CLAUDE_METRICS.seven_day]: { percent: 10, resetAt: HALFWAY_RESET } }))
  const picked = await resolveAccountForSession('s-fresh', 'claude', undefined, NOW)
  expect(picked?.subAccountId).toBe('a1')
})

test('an account with no usage rows still ranks ABOVE an exhausted one', async () => {
  // a1's scoped weekly window is spent (and scoped windows are not part
  // of the account-wide hard-limit gate, so a1 survives to the ranking).
  claudeAccounts = [account('a1'), account('a2')]
  perAccountUsage.set('a1', usage({ [SCOPED_FABLE]: { percent: 100, resetAt: HALFWAY_RESET } }))
  const picked = await resolveAccountForSession('s-unknown-beats-spent', 'claude', FABLE_MODEL, NOW)
  expect(picked?.subAccountId).toBe('a2')
})

test('balances on the weekly windows the account actually reports', async () => {
  // The production shape since Anthropic dropped the flat
  // `seven_day_opus` field: only `seven_day` plus per-model scoped rows
  // exist. Pinning the balance metric to seven_day_opus made both
  // accounts read as "no data", so the pool never rotated and the
  // account resetting in 21h wasted its entire week.
  const in21h = new Date(NOW + 21 * 3_600_000)
  const in3d = new Date(NOW + 3 * 86_400_000)
  const spent: AccountUsageMap = new Map()
  spent.set(CLAUDE_METRICS.five_hour, { percent: 75, resetAt: new Date(NOW + 39 * 60_000) })
  spent.set(CLAUDE_METRICS.seven_day, { percent: 99, resetAt: in3d })
  spent.set(SCOPED_FABLE, { percent: 9, resetAt: in3d })
  const untouched: AccountUsageMap = new Map()
  untouched.set(CLAUDE_METRICS.seven_day, { percent: 0, resetAt: in21h })
  untouched.set(SCOPED_FABLE, { percent: 0, resetAt: in21h })

  claudeAccounts = [account('a1'), account('a2')]
  perAccountUsage.set('a1', spent)
  perAccountUsage.set('a2', untouched)
  const picked = await resolveAccountForSession('s-real-shape', 'claude', undefined, NOW)
  expect(picked?.subAccountId).toBe('a2')
})

test('the tightest weekly window decides, not the freshest one', async () => {
  // a1's per-model window is untouched but its account-wide weekly is at
  // 99% — the minimum across windows is what the account can actually
  // spend, so a1 must lose to the more balanced a2.
  claudeAccounts = [account('a1'), account('a2')]
  perAccountUsage.set(
    'a1',
    usage({
      [CLAUDE_METRICS.seven_day]: { percent: 99, resetAt: HALFWAY_RESET },
      [SCOPED_FABLE]: { percent: 0, resetAt: HALFWAY_RESET }
    })
  )
  perAccountUsage.set('a2', usage({ [CLAUDE_METRICS.seven_day]: { percent: 20, resetAt: HALFWAY_RESET } }))
  const picked = await resolveAccountForSession('s-tightest', 'claude', FABLE_MODEL, NOW)
  expect(picked?.subAccountId).toBe('a2')
})

// ─── Per-model windows bind only for their own model ───────────────────

test('a spent Fable window does not hold the account back on a Sonnet request', async () => {
  // a1's Fable allowance is gone but its Sonnet headroom is the best in
  // the pool. Anthropic meters the two separately, so a1 must still win
  // a Sonnet call — treating every scoped window as binding would park
  // the account for traffic it serves fine.
  claudeAccounts = [account('a1'), account('a2')]
  perAccountUsage.set(
    'a1',
    usage({
      [SCOPED_FABLE]: { percent: 100, resetAt: HALFWAY_RESET },
      [CLAUDE_METRICS.seven_day_sonnet]: { percent: 10, resetAt: HALFWAY_RESET }
    })
  )
  perAccountUsage.set('a2', usage({ [CLAUDE_METRICS.seven_day_sonnet]: { percent: 80, resetAt: HALFWAY_RESET } }))
  const picked = await resolveAccountForSession('s-fable-spent-sonnet', 'claude', SONNET_MODEL, NOW)
  expect(picked?.subAccountId).toBe('a1')
})

test('a spent Fable window DOES skip the account on a Fable request', async () => {
  // Same account, same data — only the requested model changes. The
  // scoped window is a guaranteed 429 for this model, so the picker has
  // to rotate off it.
  claudeAccounts = [account('a1'), account('a2')]
  perAccountUsage.set('a1', usage({ [SCOPED_FABLE]: { percent: 100, resetAt: HALFWAY_RESET } }))
  perAccountUsage.set('a2', usage({ [SCOPED_FABLE]: { percent: 5, resetAt: HALFWAY_RESET } }))
  const picked = await resolveAccountForSession('s-fable-spent-fable', 'claude', FABLE_MODEL, NOW)
  expect(picked?.subAccountId).toBe('a2')
})

test('equally-ranked accounts rotate instead of pinning the first', async () => {
  // Neither account has a reading: same tier, same burn rate. The old
  // strict `>` reduce always kept the first candidate, so one account
  // took every request. Fresh ids so the least-recently-picked map
  // starts empty for both.
  claudeAccounts = [account('r1'), account('r2')]
  const first = await resolveAccountForSession('s-rot-1', 'claude', undefined, NOW)
  const second = await resolveAccountForSession('s-rot-2', 'claude', undefined, NOW + 1_000)
  expect(first?.subAccountId).not.toBe(second?.subAccountId)
})

// ─── Hard-limit filter (7d + 5h) ───────────────────────────────────────

test('a 7d-opus 100% account is filtered out even when its burn-rate score would win', async () => {
  // a1 would normally win on burn rate, but its 7d-opus is at 100%
  // with a future resetAt — guaranteed 429 if we picked it.
  claudeAccounts = [account('a1'), account('a2')]
  perAccountUsage.set('a1', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 100, resetAt: HALFWAY_RESET } }))
  perAccountUsage.set('a2', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 60, resetAt: HALFWAY_RESET } }))
  const picked = await resolveAccountForSession('s-7d-hit', 'claude', OPUS_MODEL, NOW)
  expect(picked?.subAccountId).toBe('a2')
})

test('a 5h 100% account is filtered out even when its 7d windows have headroom', async () => {
  // a1's 5h is pinned at 100% — even though 7d Opus is fresh, the
  // request would 429 immediately, so prefer a2.
  claudeAccounts = [account('a1'), account('a2')]
  perAccountUsage.set(
    'a1',
    usage({
      [CLAUDE_METRICS.five_hour]: { percent: 100, resetAt: HALFWAY_RESET },
      [CLAUDE_METRICS.seven_day_opus]: { percent: 10, resetAt: HALFWAY_RESET }
    })
  )
  perAccountUsage.set('a2', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 60, resetAt: HALFWAY_RESET } }))
  const picked = await resolveAccountForSession('s-5h-hit', 'claude', undefined, NOW)
  expect(picked?.subAccountId).toBe('a2')
})

test('a 5h 100% account with resetAt already passed is NOT filtered (stale cache)', async () => {
  // a1's cached 5h shows 100% but resetsAt is in the past — the cache
  // is stale across the reset. The picker should treat this as cleared
  // and let the account back into the candidate set so the next
  // request triggers a refresh (and probably succeeds).
  const pastReset = new Date(NOW - 10 * 60_000)
  claudeAccounts = [account('a1')]
  perAccountUsage.set(
    'a1',
    usage({
      [CLAUDE_METRICS.five_hour]: { percent: 100, resetAt: pastReset },
      [CLAUDE_METRICS.seven_day_opus]: { percent: 60, resetAt: HALFWAY_RESET }
    })
  )
  const picked = await resolveAccountForSession('s-stale', 'claude', undefined, NOW)
  expect(picked?.subAccountId).toBe('a1')
})

test('when EVERY account has a hard limit hit, the router still returns one (fall-through)', async () => {
  // No peer has headroom — both 7d-opus pinned. The router must not
  // return null (that would 401 the client); it falls through to the
  // not-exhausted set and picks by score (highest burn rate wins).
  claudeAccounts = [account('a1'), account('a2')]
  perAccountUsage.set('a1', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 100, resetAt: HALFWAY_RESET } }))
  perAccountUsage.set('a2', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 100, resetAt: HALFWAY_RESET } }))
  const picked = await resolveAccountForSession('s-all-hit', 'claude', OPUS_MODEL, NOW)
  expect(picked).not.toBeNull()
})

// ─── Reactive account exhaustion filtering ─────────────────────────────

test('an exhausted account is filtered out and the router picks a peer', async () => {
  claudeAccounts = [account('a1'), account('a2')]
  perAccountUsage.set('a1', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 20, resetAt: HALFWAY_RESET } }))
  perAccountUsage.set('a2', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 45, resetAt: HALFWAY_RESET } }))
  markAccountExhausted('a1', NOW + 5 * 60_000)
  const picked = await resolveAccountForSession('s-acct-exh', 'claude', OPUS_MODEL, NOW)
  expect(picked?.subAccountId).toBe('a2')
})

test('exhausting the sticky account causes a repick on the next call', async () => {
  claudeAccounts = [account('a1'), account('a2')]
  perAccountUsage.set('a1', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 20, resetAt: HALFWAY_RESET } }))
  perAccountUsage.set('a2', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 45, resetAt: HALFWAY_RESET } }))
  const first = await resolveAccountForSession('s-sticky-exh', 'claude', OPUS_MODEL, NOW)
  expect(first?.subAccountId).toBe('a1')

  markAccountExhausted('a1', NOW + 5 * 60_000)
  const second = await resolveAccountForSession('s-sticky-exh', 'claude', OPUS_MODEL, NOW)
  expect(second?.subAccountId).toBe('a2')
})

// ─── Sticky session ────────────────────────────────────────────────────

test('a known session sticks to its previously-chosen account', async () => {
  claudeAccounts = [account('a1'), account('a2')]
  perAccountUsage.set('a1', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 20, resetAt: HALFWAY_RESET } }))
  perAccountUsage.set('a2', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 45, resetAt: HALFWAY_RESET } }))
  const first = await resolveAccountForSession('s-sticky', 'claude', OPUS_MODEL, NOW)
  expect(first?.subAccountId).toBe('a1')
  // Flip the usage so a2 now has more headroom; the sticky map must keep
  // returning a1 for the same session id.
  perAccountUsage.set('a1', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 48, resetAt: HALFWAY_RESET } }))
  perAccountUsage.set('a2', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 10, resetAt: HALFWAY_RESET } }))
  const second = await resolveAccountForSession('s-sticky', 'claude', OPUS_MODEL, NOW)
  expect(second?.subAccountId).toBe('a1')
})

test('a sticky account that is gone triggers a repick', async () => {
  claudeAccounts = [account('a1'), account('a2')]
  perAccountUsage.set('a1', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 20, resetAt: HALFWAY_RESET } }))
  perAccountUsage.set('a2', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 45, resetAt: HALFWAY_RESET } }))
  const first = await resolveAccountForSession('s-gone', 'claude', OPUS_MODEL, NOW)
  expect(first?.subAccountId).toBe('a1')
  claudeAccounts = [account('a2')]
  const second = await resolveAccountForSession('s-gone', 'claude', OPUS_MODEL, NOW)
  expect(second?.subAccountId).toBe('a2')
})

// ─── Helper exports used by the reactive 429 path ──────────────────────

test('getActiveAccountForSession returns the picked subAccountId', async () => {
  claudeAccounts = [account('a1'), account('a2')]
  perAccountUsage.set('a1', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 20, resetAt: HALFWAY_RESET } }))
  perAccountUsage.set('a2', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 45, resetAt: HALFWAY_RESET } }))
  await resolveAccountForSession('s-active', 'claude', OPUS_MODEL, NOW)
  expect(getActiveAccountForSession('s-active')).toBe('a1')
})

test('getActiveAccountForSession returns null when the session has no sticky', () => {
  expect(getActiveAccountForSession('s-never-seen')).toBeNull()
})

test('releaseAccountForSession drops the sticky only when the subAccountId matches', async () => {
  claudeAccounts = [account('a1'), account('a2')]
  perAccountUsage.set('a1', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 20, resetAt: HALFWAY_RESET } }))
  perAccountUsage.set('a2', usage({ [CLAUDE_METRICS.seven_day_opus]: { percent: 45, resetAt: HALFWAY_RESET } }))
  await resolveAccountForSession('s-release', 'claude', OPUS_MODEL, NOW)
  expect(getActiveAccountForSession('s-release')).toBe('a1')

  releaseAccountForSession('s-release', 'a2')
  expect(getActiveAccountForSession('s-release')).toBe('a1')

  releaseAccountForSession('s-release', 'a1')
  expect(getActiveAccountForSession('s-release')).toBeNull()
})
