/**
 * The words a client is refused with when a plan's usage window is full.
 *
 * Shared by the /v1 gate and the Codex MCP tools so both say the same
 * thing. The client reads this in a CLI where it is often the only
 * diagnostic it gets, so it names the window, which limit was reached,
 * and the instant it resets — an absolute time, because a relative one
 * is wrong by the time anyone reads it.
 */

import type { ExhaustedBy, UsageWindow } from '../services/usage-window-service'

const WINDOW_NAME: Readonly<Record<UsageWindow, string>> = { '5h': '5-hour', '7d': '7-day' }

const LIMIT_NAME: Readonly<Record<ExhaustedBy, string>> = { requests: 'request', spend: 'spend' }

export function windowLimitMessage(exhausted: { window: UsageWindow; by: ExhaustedBy; resetsAt: string }): string {
  return `This access token has reached its plan's ${WINDOW_NAME[exhausted.window]} ${LIMIT_NAME[exhausted.by]} limit. The window resets at ${exhausted.resetsAt}.`
}

export const USAGE_LEDGER_UNAVAILABLE =
  'The usage ledger is unavailable, so this limited token cannot be admitted right now.'
