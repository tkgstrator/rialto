/**
 * How the unreachable screen polls /health, and when it retries the
 * config fetch that sent the operator there.
 *
 * Every /health runs a query against Postgres, and every config retry
 * that fails logs a stack trace. The screen once did both back to back
 * with no delay at all: /health answered, the config was retried, it
 * failed again, and the re-render restarted the poll. A database that is
 * down or behind on its migrations is not fixed by being asked more
 * often, so the poll slows down and the retry happens once per recovery.
 */

import type { HealthResponse } from '@/lib/api'

const POLL_MS = 5000
const MAX_POLL_MS = 60_000

/** The wait after probe number `attempt` (from 0): doubling from 5s, capped at a minute. */
export const pollDelay = (attempt: number): number => Math.min(POLL_MS * 2 ** attempt, MAX_POLL_MS)

/**
 * /health answered and its database check did not fail, so a config
 * fetch now has a chance. A 503 still carries a body, which is why
 * answering alone is not enough.
 */
export const canServe = (health: HealthResponse | null): boolean => health !== null && health.checks.db !== 'fail'

/**
 * Retry the config on the first probe that finds the server able to
 * serve, and after that only when one before it did not. A config fetch
 * that fails while /health passes fails for a reason /health cannot see,
 * such as a database with no tables yet; repeating it only repeats the
 * error, so from there the Retry button decides.
 */
export const shouldRetryConfig = (couldServe: boolean, canServeNow: boolean): boolean => canServeNow && !couldServe
