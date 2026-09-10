/**
 * How long a 429'd subscription account stays parked.
 *
 * `earliestResetUntil` turns the account's observed windows into the
 * deadline for its exhaustion mark. Getting it wrong is not visible as a
 * failure — the request still succeeds on a peer account — it shows up as
 * an account being re-probed and 429'd on a loop, which is why this is
 * worth pinning rather than leaving to the end-to-end failover test.
 *
 * The case that motivated it: Anthropic meters a model's weekly
 * allowance in `claude.seven_day_scoped.<model>`, and the old
 * implementation walked a pinned list of account-wide keys. A Fable 429
 * therefore matched no window, fell through to the caller's 5-minute
 * default, and the account came back every 5 minutes for the rest of the
 * week to be refused again.
 */
import { expect, test } from 'bun:test'
import { earliestResetUntil } from '../../src/api/v1/chain-failover'
import dayjs from '../../src/lib/dayjs'
import {
  type AccountUsageMap,
  CLAUDE_METRICS,
  CODEX_METRICS,
  type Metric,
  scopedMetricKey
} from '../../src/services/subaccount-usage-store'

const NOW = dayjs('2026-09-10T00:00:00.000Z').valueOf()
const inHours = (n: number): Date => dayjs(NOW).add(n, 'hour').toDate()
const inDays = (n: number): Date => dayjs(NOW).add(n, 'day').toDate()

const FABLE_MODEL = 'claude-fable-5-1'
const SONNET_MODEL = 'claude-sonnet-5'
const CODEX_MODEL = 'gpt-5-codex'

// The per-model weekly window Anthropic actually reports today. Built
// through `scopedMetricKey` rather than written out, so the test breaks
// if the key format ever moves.
const SCOPED_FABLE = scopedMetricKey('Fable')

const usage = (entries: readonly [Metric, { percent: number; resetAt: Date | null }][]): AccountUsageMap =>
  new Map(entries)

// Comfortably below the near-limit mark, so these can never be the window
// credited with a 429 — they are here to prove they are passed over.
const HEALTHY = { percent: 20, resetAt: inHours(2) }

test('a spent per-model weekly window is what parks the account', () => {
  const fableReset = inDays(5)
  const until = earliestResetUntil(
    usage([
      [CLAUDE_METRICS.five_hour, HEALTHY],
      [CLAUDE_METRICS.seven_day, { percent: 40, resetAt: inDays(3) }],
      [SCOPED_FABLE, { percent: 100, resetAt: fableReset }]
    ]),
    'claude',
    FABLE_MODEL,
    NOW
  )
  // Previously undefined — no account-wide window was near limit, and the
  // scoped one was not in the pinned list — which meant a 5-minute
  // cooldown on a window that had a further five days to run.
  expect(until).toBe(fableReset.valueOf())
})

test("another model's spent window does not park the account", () => {
  const until = earliestResetUntil(
    usage([
      [CLAUDE_METRICS.five_hour, HEALTHY],
      [CLAUDE_METRICS.seven_day, HEALTHY],
      // Fable is gone, but this request asked for Sonnet, which that
      // window says nothing about. Crediting it would park an account
      // that serves Sonnet perfectly well.
      [SCOPED_FABLE, { percent: 100, resetAt: inDays(5) }]
    ]),
    'claude',
    SONNET_MODEL,
    NOW
  )
  expect(until).toBeUndefined()
})

test('the nearest reset among the near-limit windows wins', () => {
  const fiveHourReset = inHours(2)
  const until = earliestResetUntil(
    usage([
      // Both are pinned. The account becomes usable again at the first of
      // them, so parking it until the weekly reset would throw away the
      // days in between.
      [CLAUDE_METRICS.five_hour, { percent: 100, resetAt: fiveHourReset }],
      [CLAUDE_METRICS.seven_day, { percent: 98, resetAt: inDays(4) }]
    ]),
    'claude',
    SONNET_MODEL,
    NOW
  )
  expect(until).toBe(fiveHourReset.valueOf())
})

test('a window with headroom is not credited with the 429', () => {
  const until = earliestResetUntil(
    usage([[CLAUDE_METRICS.seven_day, { percent: 89, resetAt: inDays(3) }]]),
    'claude',
    SONNET_MODEL,
    NOW
  )
  // 89% cannot be what the upstream is enforcing, so the caller keeps its
  // default cooldown rather than parking the account for three days.
  expect(until).toBeUndefined()
})

test('a reset that has already passed is ignored', () => {
  const until = earliestResetUntil(
    usage([[CLAUDE_METRICS.seven_day, { percent: 100, resetAt: inHours(-1) }]]),
    'claude',
    SONNET_MODEL,
    NOW
  )
  // A row left stale across its own reset. Returning a past deadline
  // would mark the account exhausted and instantly un-exhaust it.
  expect(until).toBeUndefined()
})

test('a null reset is ignored', () => {
  const until = earliestResetUntil(
    usage([[CLAUDE_METRICS.seven_day, { percent: 100, resetAt: null }]]),
    'claude',
    SONNET_MODEL,
    NOW
  )
  expect(until).toBeUndefined()
})

test("codex's weekly window parks the account, not just its short one", () => {
  const weeklyReset = inDays(3)
  const until = earliestResetUntil(
    usage([
      [CODEX_METRICS.primary, HEALTHY],
      [CODEX_METRICS.secondary, { percent: 100, resetAt: weeklyReset }]
    ]),
    'codex',
    CODEX_MODEL,
    NOW
  )
  // The pinned list held only `codex.primary`, so a weekly-limit 429 also
  // fell through to the 5-minute default.
  expect(until).toBe(weeklyReset.valueOf())
})

test("the other kind's windows are never credited", () => {
  const until = earliestResetUntil(
    usage([[CODEX_METRICS.secondary, { percent: 100, resetAt: inDays(3) }]]),
    'claude',
    SONNET_MODEL,
    NOW
  )
  expect(until).toBeUndefined()
})

test('an unreadable model falls back to the account-wide windows', () => {
  const weeklyReset = inDays(3)
  const until = earliestResetUntil(
    usage([
      [CLAUDE_METRICS.seven_day, { percent: 100, resetAt: weeklyReset }],
      // Per-model windows need a model to compare against; with none, they
      // are neither credited nor allowed to park the account.
      [SCOPED_FABLE, { percent: 100, resetAt: inHours(1) }]
    ]),
    'claude',
    undefined,
    NOW
  )
  expect(until).toBe(weeklyReset.valueOf())
})
