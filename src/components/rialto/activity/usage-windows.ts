/**
 * Subscription window and account usage shaping for Activity › Usage.
 *
 * The screen has three panels reading three endpoints, and each one needs
 * the wire shape turned into something a table or a chart can consume.
 * None of that needs React, and all of it is the part that can be wrong in
 * a way nobody notices — a mislabelled series, a share column that sums to
 * 140% — so it lives here where a test can hold it.
 */

import type { SubscriptionWire } from '@/components/rialto/providers/types'
import { vendorLabel } from '@/components/rialto/providers/vendor-labels'
import type { OverviewAccountUsage } from '@/lib/api-types'
import type { SeatKind } from '@/shared/plan-capacity'
import { planLabel } from '@/shared/plan-label'
import { windowProjectedPct } from '@/shared/quota-pace'

// ---- Subscription windows -------------------------------------------

/** One utilization window as the windows panel renders it. */
export interface WindowRow {
  /** Window kind: `5-hour`, `7-day`, `primary`, … Already translated. */
  label: string
  /** Model this window is scoped to, when it is. Rendered as a mono tag. */
  scope: string | null
  pct: number
  projectedPct: number | null
  resetsAt: string | null
}

export interface AccountWindows {
  subAccountId: string
  account: string
  /** The plan with its multiplier — "Max 20x", "Pro 5x". Null when unknown. */
  plan: string | null
  windows: WindowRow[]
}

/** One subscription provider and its accounts, as the panel groups them. */
export interface ProviderWindows {
  /** Stable React key: the Provider row name, or the vendor for unclaimed accounts. */
  key: string
  /** Display name — "Claude Code" for `claude-code`, the slug itself for a hand-added one. */
  label: string
  /** The Provider row name, when it says something the label does not. */
  name: string | null
  kind: 'claude' | 'codex' | 'other'
  accounts: AccountWindows[]
}

/** `/api/usage` as the browser consumes it. Mirrors schemas/api/usage.ts. */
export interface UsageWindowValue {
  utilization: number
  resetsAt: string | null
}

export interface UsageScopedWindow {
  modelName: string
  utilization: number
  resetsAt: string | null
}

export interface ClaudeUsageWire {
  subAccountId: string
  accountLabel: string
  fiveHour: UsageWindowValue | null
  sevenDay: UsageWindowValue | null
  sevenDaySonnet: UsageWindowValue | null
  sevenDayOpus: UsageWindowValue | null
  weeklyScoped: UsageScopedWindow[]
  extraUsageEnabled: boolean
  capturedAt: string
}

export interface CodexUsageWire {
  subAccountId: string
  accountLabel: string
  planType: string | null
  primary: { usedPercent: number; resetAt: string | null; windowSeconds: number | null } | null
  secondary: { usedPercent: number; resetAt: string | null; windowSeconds: number | null } | null
  capturedAt: string
}

export interface UsageWire {
  claude: ClaudeUsageWire[]
  codex: CodexUsageWire[]
}

/** Translation keys the window labels resolve through. */
export const WINDOW_LABEL_KEYS = {
  fiveHour: 'activity.usage.windowFiveHour',
  sevenDay: 'activity.usage.windowSevenDay',
  sevenDayScoped: 'activity.usage.windowSevenDayScoped',
  primary: 'activity.usage.windowPrimary',
  secondary: 'activity.usage.windowSecondary'
} as const

type Translate = (key: string) => string

const FIVE_HOURS_S = 5 * 60 * 60
const SEVEN_DAYS_S = 7 * 24 * 60 * 60
const STALE_USAGE_MS = 15 * 60 * 1000

const paceOf = (pct: number, reset: string | null, seconds: number | null, observed: string): number | null => {
  const observedAt = Date.parse(observed)
  // A cached reading cannot describe the current pace after polling stops.
  if (!Number.isFinite(observedAt) || Math.abs(Date.now() - observedAt) > STALE_USAGE_MS) return null
  // Upstream leaves the reset unset until an idle window starts being used.
  if (pct === 0 && reset === null) return 0
  const resetAt = reset === null ? null : Date.parse(reset)
  const value = windowProjectedPct(
    pct,
    resetAt === null || Number.isNaN(resetAt) ? null : resetAt,
    seconds === null ? null : seconds * 1000,
    observedAt
  )
  return value === null ? null : Math.round(value * 10) / 10
}

/**
 * One Claude account's windows, account-wide first then per-model.
 *
 * The scoped weekly windows are the reason this panel exists: Overview's
 * `quota` array carries only the flat 5h/7d pair, so a per-model limit
 * (the one that actually stops a Fable request) is currently visible
 * nowhere. They come after the account-wide ones because an operator
 * scanning for "am I near the wall" reads the broader limit first.
 *
 * `sevenDaySonnet` / `sevenDayOpus` are the pre-`limits[]` spelling of the
 * same thing. Anthropic stopped populating them for most plans, so they
 * are emitted only when present and are never synthesised from the scoped
 * list — showing one window twice under two names is worse than once.
 */
const claudeWindows = (account: ClaudeUsageWire, t: Translate): WindowRow[] => {
  const windows: WindowRow[] = []
  const flat: [UsageWindowValue | null, string, number][] = [
    [account.fiveHour, t(WINDOW_LABEL_KEYS.fiveHour), FIVE_HOURS_S],
    [account.sevenDay, t(WINDOW_LABEL_KEYS.sevenDay), SEVEN_DAYS_S]
  ]
  for (const [value, label, seconds] of flat) {
    if (value !== null)
      windows.push({
        label,
        scope: null,
        pct: value.utilization,
        projectedPct: paceOf(value.utilization, value.resetsAt, seconds, account.capturedAt),
        resetsAt: value.resetsAt
      })
  }
  const scopedLabel = t(WINDOW_LABEL_KEYS.sevenDayScoped)
  const legacyScoped: [UsageWindowValue | null, string][] = [
    [account.sevenDaySonnet, 'Sonnet'],
    [account.sevenDayOpus, 'Opus']
  ]
  for (const [value, scope] of legacyScoped) {
    if (value !== null) {
      windows.push({
        label: scopedLabel,
        scope,
        pct: value.utilization,
        projectedPct: paceOf(value.utilization, value.resetsAt, SEVEN_DAYS_S, account.capturedAt),
        resetsAt: value.resetsAt
      })
    }
  }
  for (const scoped of account.weeklyScoped) {
    windows.push({
      label: scopedLabel,
      scope: scoped.modelName,
      pct: scoped.utilization,
      projectedPct: paceOf(scoped.utilization, scoped.resetsAt, SEVEN_DAYS_S, account.capturedAt),
      resetsAt: scoped.resetsAt
    })
  }
  return windows
}

/**
 * A Codex window named by its length when the wire says it, by rank when
 * it does not.
 *
 * Codex calls its two windows primary and secondary, and they are the same
 * 5-hour and 7-day limits Claude publishes. Naming one vendor's pair by
 * duration and the other's by rank made the same two limits look like
 * different ones. `windowSeconds` is what says which is which; a length
 * that is neither keeps the rank rather than being forced into one.
 */
const codexWindowLabel = (seconds: number | null, rank: string, t: Translate): string => {
  if (seconds === FIVE_HOURS_S) return t(WINDOW_LABEL_KEYS.fiveHour)
  if (seconds === SEVEN_DAYS_S) return t(WINDOW_LABEL_KEYS.sevenDay)
  return rank
}

const codexWindows = (account: CodexUsageWire, t: Translate): WindowRow[] => {
  const flat: [CodexUsageWire['primary'], string][] = [
    [account.primary, t(WINDOW_LABEL_KEYS.primary)],
    [account.secondary, t(WINDOW_LABEL_KEYS.secondary)]
  ]
  const windows: WindowRow[] = []
  for (const [value, rank] of flat) {
    if (value !== null) {
      windows.push({
        label: codexWindowLabel(value.windowSeconds, rank, t),
        scope: null,
        pct: value.usedPercent,
        projectedPct: paceOf(value.usedPercent, value.resetAt, value.windowSeconds, account.capturedAt),
        resetsAt: value.resetAt
      })
    }
  }
  return windows
}

/** One account from `/api/usage`, before it is placed under a provider. */
interface UsageSeat {
  subAccountId: string
  account: string
  vendor: 'claude' | 'codex'
  /** Codex's `plan_type`, read live on every poll. Claude's usage response has none. */
  livePlan: string | null
  windows: WindowRow[]
}

const usageSeats = (usage: UsageWire, t: Translate): UsageSeat[] => [
  ...usage.claude.map(
    (a): UsageSeat => ({
      subAccountId: a.subAccountId,
      account: a.accountLabel,
      vendor: 'claude',
      livePlan: null,
      windows: claudeWindows(a, t)
    })
  ),
  ...usage.codex.map(
    (a): UsageSeat => ({
      subAccountId: a.subAccountId,
      account: a.accountLabel,
      vendor: 'codex',
      livePlan: a.planType,
      windows: codexWindows(a, t)
    })
  )
]

const seatKindOf = (kind: ProviderWindows['kind']): SeatKind => (kind === 'other' ? null : kind)

/** Vendor names for accounts no provider claimed. Proper nouns, not copy. */
const VENDOR_NAME = { claude: 'Claude', codex: 'Codex' } as const

/** One provider's accounts, in the order `/api/subscriptions` lists them. */
const providerGroup = (sub: SubscriptionWire, seats: ReadonlyMap<string, UsageSeat>): ProviderWindows => {
  const accounts = sub.accounts.flatMap((account): AccountWindows[] => {
    const seat = seats.get(account.id)
    if (seat === undefined) return []
    // Codex's live `plan_type` over the stored one, which dates from the
    // last sign-in. Claude's tier only ever arrives through the stored row.
    const plan = seat.livePlan === null ? account.plan : seat.livePlan
    return [
      {
        subAccountId: seat.subAccountId,
        account: seat.account,
        plan: planLabel(seatKindOf(sub.kind), plan, account.rateLimitTier),
        windows: seat.windows
      }
    ]
  })
  const label = vendorLabel(sub.providerName, sub.providerName)
  return {
    key: sub.providerName,
    label,
    name: label === sub.providerName ? null : sub.providerName,
    kind: sub.kind,
    accounts
  }
}

/**
 * `/api/usage`, grouped by the provider each account belongs to.
 *
 * `/api/usage` is one list per vendor, and the panel used to flow Claude's
 * accounts then Codex's through one two-column grid, so a row could hold
 * one of each with nothing on either saying which vendor it was — and
 * "5-hour 88%" reads the same under both. `/api/subscriptions` knows which
 * Provider row owns each account, in the order the Providers screen lists
 * them, so the panel groups by that instead. A provider with no account
 * in the usage response has nothing to draw and is left out.
 *
 * An account the subscriptions list does not name — its read failed, or
 * the account went between the two reads — is still shown, under its
 * vendor. Dropping it would hide a window that is really being spent.
 */
export function providerWindows(
  usage: UsageWire,
  subscriptions: readonly SubscriptionWire[],
  t: Translate
): ProviderWindows[] {
  const seats = new Map(usageSeats(usage, t).map((seat) => [seat.subAccountId, seat]))
  const listed = new Set(subscriptions.flatMap((sub) => sub.accounts.map((account) => account.id)))
  const grouped = subscriptions.map((sub) => providerGroup(sub, seats)).filter((group) => group.accounts.length > 0)
  const unclaimed = (['claude', 'codex'] as const).flatMap((vendor): ProviderWindows[] => {
    const orphans = [...seats.values()].filter((seat) => seat.vendor === vendor && !listed.has(seat.subAccountId))
    if (orphans.length === 0) return []
    return [
      {
        key: `vendor:${vendor}`,
        label: VENDOR_NAME[vendor],
        name: null,
        kind: vendor,
        accounts: orphans.map((seat) => ({
          subAccountId: seat.subAccountId,
          account: seat.account,
          plan: planLabel(vendor, seat.livePlan, null),
          windows: seat.windows
        }))
      }
    ]
  })
  return [...grouped, ...unclaimed]
}

// ---- API-equivalent usage -------------------------------------------

/** Each account's API-equivalent figures, by SubAccount id. */
export type AccountUsageIndex = ReadonlyMap<string, OverviewAccountUsage>

/**
 * Overview's quota rows reduced to the figures drawn under an account.
 *
 * A row whose aggregate could not be read is left out rather than kept as
 * null, so a lookup that misses means one thing — nothing to draw — whether
 * the account has no quota row or its figures failed.
 */
export function indexAccountUsage(
  rows: ReadonlyArray<{ subAccountId: string; usage: OverviewAccountUsage | null }>
): AccountUsageIndex {
  return new Map(
    rows.flatMap((row): [string, OverviewAccountUsage][] => (row.usage === null ? [] : [[row.subAccountId, row.usage]]))
  )
}
