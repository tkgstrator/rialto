/**
 * In-process snapshot store for the routing scheduler.
 *
 * The publisher swaps a frozen `RoutingSnapshot` reference; readers
 * only ever see a complete snapshot. JS is single-threaded, so the
 * reference swap is atomic — no lock, no race.
 */

import type { RoutingSnapshot } from './types'

const store: { current: RoutingSnapshot | null } = { current: null }

export function getRoutingSnapshot(): RoutingSnapshot | null {
  return store.current
}

export function publishSnapshot(next: RoutingSnapshot): void {
  Object.freeze(next.targets)
  Object.freeze(next.accounts)
  store.current = Object.freeze(next)
}

// Test-only reset — the tick loop calls `stopRoutingScheduler` for the
// timer, and this clears the snapshot store so subsequent tests start
// clean.
export function __resetSchedulerStateForTest(): void {
  store.current = null
}
