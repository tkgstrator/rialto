/**
 * Formatters shared by the Rialto screens.
 *
 * Dependency-free so they can be unit-tested without React or i18n.
 * Money is NOT here on purpose — `fmtCost` in lib/sessions/format.ts is
 * the one money formatter and every screen imports it.
 */

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Compact elapsed time: `2m`, `19m`, `1h`, `3d`. Used in the "last seen"
 * column, where the exact instant is a tooltip and the column only has to
 * answer "recent or not".
 */
export function fmtAgo(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return '–'
  const secs = Math.max(0, Math.round((now - then) / 1000))
  if (secs < MINUTE) return `${secs}s`
  if (secs < HOUR) return `${Math.floor(secs / MINUTE)}m`
  if (secs < DAY) return `${Math.floor(secs / HOUR)}h`
  return `${Math.floor(secs / DAY)}d`
}

/**
 * Time remaining, at the two-unit precision the quota rows use:
 * `2h 11m`, `3d 04h`, `46m`. Returns 'now' once the instant has passed —
 * a reset that is due reads better than a negative duration.
 */
/**
 * Time left until `iso`, or `null` when it has already passed.
 *
 * The elapsed case returns null rather than a word: it used to return
 * the literal `'now'`, which every caller then interpolated into
 * "resets in {{until}}" — reading "resets in now" in English and
 * leaving an untranslated "now" in the JA and ZH builds. Wording that
 * case is the caller's job because only the caller has the sentence.
 */
export function fmtUntil(iso: string | null, now: number): string | null {
  if (iso === null) return '–'
  const target = Date.parse(iso)
  if (Number.isNaN(target)) return '–'
  const secs = Math.round((target - now) / 1000)
  if (secs <= 0) return null
  if (secs < HOUR) return `${Math.ceil(secs / MINUTE)}m`
  if (secs < DAY) {
    const h = Math.floor(secs / HOUR)
    const m = Math.floor((secs % HOUR) / MINUTE)
    return `${h}h ${String(m).padStart(2, '0')}m`
  }
  const d = Math.floor(secs / DAY)
  const h = Math.floor((secs % DAY) / HOUR)
  return `${d}d ${String(h).padStart(2, '0')}h`
}

/**
 * Elapsed process uptime: `42s`, `37m 12s`, `3h 24m`, `7d 11h 10m`.
 *
 * Three units once it passes a day, two below that — an uptime is read
 * to answer "how long has this been up", and a server up for a week does
 * not need its seconds. Secondary units are zero-padded like `fmtUntil`
 * so the value stays column-aligned in the tabular-nums readouts.
 *
 * `/health` keeps reporting `uptime_seconds` as an integer: that is the
 * machine-readable contract an uptime monitor parses, and this is only
 * how the two Settings screens render it.
 */
export function fmtUptime(seconds: number): string {
  const secs = Math.max(0, Math.floor(seconds))
  if (secs < MINUTE) return `${secs}s`
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (secs < HOUR) return `${Math.floor(secs / MINUTE)}m ${pad(secs % MINUTE)}s`
  if (secs < DAY) return `${Math.floor(secs / HOUR)}h ${pad(Math.floor((secs % HOUR) / MINUTE))}m`
  const d = Math.floor(secs / DAY)
  const h = Math.floor((secs % DAY) / HOUR)
  const m = Math.floor((secs % HOUR) / MINUTE)
  return `${d}d ${pad(h)}h ${pad(m)}m`
}

/** Compact request counts: 486, 3.1k, 12.4k, 1.20M. */
export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Latency in the p50 column: `1.9s` above a second, `840ms` below. */
export function fmtLatency(ms: number | null): string {
  if (ms === null) return '–'
  if (ms >= 1_000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}

/**
 * Error share as a percentage with one decimal. A surface with no traffic
 * has no error rate — that is different from a 0% rate, so it renders as
 * an em dash rather than 0.0%.
 */
export function fmtRate(rate: number | null): string {
  if (rate === null) return '–'
  return `${(rate * 100).toFixed(1)}%`
}

/** Truncate a session id to the `ses_9fa2…c41` form the tables use. */
export function shortId(id: string): string {
  if (id.length <= 16) return id
  return `${id.slice(0, 8)}…${id.slice(-3)}`
}
