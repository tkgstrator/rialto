/**
 * A spent account-wide window takes the rest of the account's windows with it.
 *
 * The account-wide windows — Claude's 5h and 7d, Codex's primary and
 * secondary — each gate every request on the account, whatever the model.
 * Once either is hit the upstream refuses everything, yet it keeps
 * reporting the other windows on their own terms: with the 7d spent the 5h
 * window sits near 0% because nothing can be sent to fill it, and with the
 * 5h spent the 7d and a per-model weekly window (Fable) show only what had
 * been used before the account ran dry. Read as reported, an account that
 * cannot serve a single request looked like it had allowance left — to the
 * scheduler, whose Fable budget and Retry-After read only the scoped
 * window, and to every panel that renders a window's percentage.
 *
 * A spent per-model window is not a source: it refuses its own model only,
 * and the account keeps serving the rest.
 *
 * Applied once, where the vendor response is parsed, so the cache,
 * SubAccountUsage, SubAccountQuota and UsageSnapshot are all written from
 * the same folded value and no reader has to remember the rule.
 */

import dayjs from '../../lib/dayjs'
import type { ClaudeUsage, ClaudeUsageWindowValue, CodexUsage, CodexUsageWindowValue } from '../../schemas/api/usage'

// A window counts as hit at the ceiling itself, not at the account
// picker's early HARD_LIMIT_PCT: until the upstream actually refuses, the
// other windows still describe capacity that is really there.
const LIMIT_HIT_PCT = 100

interface WindowReading {
  pct: number
  resetAt: string | null
}

// How spent the account reads while it is refused, and until when.
interface Block {
  pct: number
  until: string | null
}

const resetsLater = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && dayjs(a).valueOf() > dayjs(b).valueOf()

// The account stays refused until the LAST of its hit windows resets: with
// both 5h and 7d spent, the 5h rolling over changes nothing. A hit window
// with no reported reset cannot move that point, so it only contributes
// its percentage. Null while no account-wide window is hit.
const blockOf = (accountWide: readonly (WindowReading | null)[]): Block | null => {
  const hit = accountWide.filter((w): w is WindowReading => w !== null && w.pct >= LIMIT_HIT_PCT)
  if (hit.length === 0) return null
  return hit.reduce<Block>(
    (block, w) => ({
      pct: Math.max(block.pct, w.pct),
      until: block.until === null || resetsLater(w.resetAt, block.until) ? w.resetAt : block.until
    }),
    { pct: LIMIT_HIT_PCT, until: null }
  )
}

// One window as the upstream enforces it while the account is refused:
// spent, and unusable until the block ends. The exception is a window
// spent on its own that resets even later — its reset, not the block's,
// is when it comes back, so its own reading is the truthful one.
const underBlock = (own: WindowReading, block: Block): WindowReading => {
  if (own.pct >= LIMIT_HIT_PCT && resetsLater(own.resetAt, block.until)) return own
  return { pct: Math.max(own.pct, block.pct), resetAt: block.until }
}

const claudeReading = (w: ClaudeUsageWindowValue): WindowReading => ({ pct: w.utilization, resetAt: w.resetsAt })

const foldClaude = <T extends ClaudeUsageWindowValue>(own: T, block: Block): T => {
  const folded = underBlock(claudeReading(own), block)
  return { ...own, utilization: folded.pct, resetsAt: folded.resetAt }
}

// A window the upstream did not report stays unreported: the spent window
// already carries the block, and inventing a reading would put a number
// on the panel that no vendor ever sent.
export function applyClaudeAccountLimit(usage: ClaudeUsage): ClaudeUsage {
  const block = blockOf([usage.fiveHour, usage.sevenDay].map((w) => (w === null ? null : claudeReading(w))))
  if (block === null) return usage
  const fold = <T extends ClaudeUsageWindowValue>(own: T | null): T | null =>
    own === null ? null : foldClaude(own, block)
  return {
    ...usage,
    fiveHour: fold(usage.fiveHour),
    sevenDay: fold(usage.sevenDay),
    sevenDaySonnet: fold(usage.sevenDaySonnet),
    sevenDayOpus: fold(usage.sevenDayOpus),
    weeklyScoped: usage.weeklyScoped.map((scoped) => foldClaude(scoped, block))
  }
}

const codexReading = (w: CodexUsageWindowValue): WindowReading => ({ pct: w.usedPercent, resetAt: w.resetAt })

// Codex meters no per-model windows, so its two account-wide windows only
// have each other to take along.
export function applyCodexAccountLimit(usage: CodexUsage): CodexUsage {
  const block = blockOf([usage.primary, usage.secondary].map((w) => (w === null ? null : codexReading(w))))
  if (block === null) return usage
  const fold = (own: CodexUsageWindowValue | null): CodexUsageWindowValue | null => {
    if (own === null) return null
    const folded = underBlock(codexReading(own), block)
    return { ...own, usedPercent: folded.pct, resetAt: folded.resetAt }
  }
  return { ...usage, primary: fold(usage.primary), secondary: fold(usage.secondary) }
}
