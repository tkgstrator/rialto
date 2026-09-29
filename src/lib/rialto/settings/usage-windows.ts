/**
 * Pure logic behind a token's "Usage windows" field.
 *
 * The server reports each window as it stands — open or not, counts,
 * limits — and leaves the judgement to the reader. The gate refuses a
 * request when any open window has reached any of its limits, so that is
 * the rule reproduced here: a spent window is named with the measure that
 * spent it, and the block lasts until the latest of the spent windows
 * resets (an available 5-hour window cannot lift a spent 7-day one).
 */

import type { TokenUsageWindowsWire, UsageWindowWire } from '@/lib/api-types'
import dayjs from '@/lib/dayjs'

/** Which of a window's two limits it has reached. */
export type SpentMeasure = 'requests' | 'spend'

export interface Measure {
  used: number
  /** Null when the plan sets no limit on this measure. */
  limit: number | null
  /** The meter's fill, 0-100; null with no limit, which draws no bar at all. */
  pct: number | null
}

export interface WindowView {
  window: UsageWindowWire['window']
  /** False before the first counted request, after a reset, or once the window has lapsed. */
  started: boolean
  resetsAt: string | null
  requests: Measure
  spend: Measure
  /** The limits this window has reached, in the order the page lists them. */
  spentBy: SpentMeasure[]
}

/** A measure's reading, its bar capped at full. */
const measureOf = (used: number, limit: number | null): Measure => ({
  used,
  limit,
  pct: limit === null ? null : Math.min(100, (used / limit) * 100)
})

export function windowView(row: UsageWindowWire): WindowView {
  const started = row.resetsAt !== null
  const reached: readonly (readonly [SpentMeasure, boolean])[] = [
    ['requests', row.requestLimit !== null && row.requests >= row.requestLimit],
    ['spend', row.spendLimitUsd !== null && row.costUsd >= row.spendLimitUsd]
  ]
  return {
    window: row.window,
    started,
    resetsAt: row.resetsAt,
    requests: measureOf(row.requests, row.requestLimit),
    spend: measureOf(row.costUsd, row.spendLimitUsd),
    spentBy: started ? reached.filter(([, hit]) => hit).map(([measure]) => measure) : []
  }
}

export interface UsageBlock {
  /** When requests resume: the latest reset among the spent windows. */
  until: string
  /** Every reached limit, window by window. */
  reasons: { window: UsageWindowWire['window']; measure: SpentMeasure }[]
}

/** What the field shows, as one of the states the mock draws. */
export type UsageWindowsView =
  | { kind: 'loading' }
  | { kind: 'no-plan' }
  | { kind: 'unlimited'; planName: string }
  | {
      kind: 'limited'
      windows: WindowView[]
      /** Null while every window can still admit a request. */
      block: UsageBlock | null
      /** Whether any window is open, and so whether there is anything to reset. */
      resettable: boolean
    }

/** The field's state from the token's saved plan and the server's reading of its windows. */
export function usageWindowsView(planName: string | null, usage: TokenUsageWindowsWire | null): UsageWindowsView {
  if (planName === null) return { kind: 'no-plan' }
  if (usage === null) return { kind: 'loading' }
  if (!usage.limited) return { kind: 'unlimited', planName }
  const windows = usage.windows.map(windowView)
  const spent = windows.filter((w) => w.spentBy.length > 0)
  const until = spent
    .flatMap((w) => (w.resetsAt === null ? [] : [w.resetsAt]))
    .reduce<string | null>((latest, at) => (latest === null || dayjs(at).isAfter(dayjs(latest)) ? at : latest), null)
  const block =
    until === null
      ? null
      : { until, reasons: spent.flatMap((w) => w.spentBy.map((measure) => ({ window: w.window, measure }))) }
  return { kind: 'limited', windows, block, resettable: windows.some((w) => w.started) }
}

/** Whether the token is refused right now by its plan's usage limits. */
export const usageBlocked = (view: UsageWindowsView): boolean => view.kind === 'limited' && view.block !== null

const ALPHABETIC_ZONE = /^[A-Z]{2,5}$/

const zonePart = (at: string, locale: string, style: 'short' | 'longOffset', timeZone: string | undefined) =>
  new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: style })
    .formatToParts(dayjs(at).toDate())
    .find((part) => part.type === 'timeZoneName')

/** The viewer's UTC offset at `at`, as "+09:00". */
export function zoneOffset(at: string, timeZone?: string): string {
  const part = zonePart(at, 'en-US', 'longOffset', timeZone)
  if (part === undefined || part.value === 'GMT') return '+00:00'
  return part.value.replace('GMT', '')
}

/**
 * The viewer's zone as a short name: "JST", "PDT", "UTC".
 *
 * `Intl` spells most zones "GMT+9" in most locales and keeps the letters
 * for the locales that commonly use them (JST only in ja, PDT in en-US,
 * CEST in en-GB), so those are asked in turn, falling back to the UTC
 * offset when none has a name.
 */
export function zoneName(at: string, locale: string, timeZone?: string): string {
  const named = [locale, 'en-US', 'en-GB', 'ja-JP']
    .map((candidate) => zonePart(at, candidate, 'short', timeZone))
    .find((part) => part !== undefined && ALPHABETIC_ZONE.test(part.value))
  return named === undefined ? `UTC${zoneOffset(at, timeZone)}` : named.value
}

/** A window's reset instant in the viewer's zone: "Sep 29, 18:00 JST". */
export function fmtResetAt(iso: string, locale: string, timeZone?: string): string {
  const clock = new Intl.DateTimeFormat(locale, {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(dayjs(iso).toDate())
  return `${clock} ${zoneName(iso, locale, timeZone)}`
}

/** Spend as the windows show it, always to the cent: "$0.84", "$10.00". */
export const fmtUsd = (usd: number): string => `$${usd.toFixed(2)}`
