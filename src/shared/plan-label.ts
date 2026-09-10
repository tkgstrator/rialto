/**
 * The name a subscription seat's plan is shown under.
 *
 * The stored strings are the vendors' identifiers, and none of them is a
 * name: Claude reports `claude_max` and puts the level in a separate
 * `rate_limit_tier` ("default_claude_max_20x"), and Codex reports `prolite`
 * for the 5x Pro seat and a bare `pro` for the 20x one. Printed as they
 * come — "max", "pro" — a pill cannot say which of a vendor's two top plans
 * the seat is on, and that is the one thing the meters beside it need: a
 * 20x at 60% has four times the headroom of a 5x at 60%.
 *
 * So the multiplier is part of the name whenever the plan has two levels,
 * and the base plans (Claude Pro, Codex Plus) carry none. A Claude Max
 * whose tier never arrived is shown as plain "Max" rather than guessed at.
 * Anything unrecognised is shown as its own words, so a plan a vendor adds
 * tomorrow reads as itself instead of disappearing.
 *
 * Reads the same strings `planCapacityWeight` does, so the name on screen
 * and the weight the scheduler gives the seat cannot disagree.
 */
import type { SeatKind } from './plan-capacity'

const lower = (value: string | null): string => (value === null ? '' : value.toLowerCase())

// `self_serve_business` → "Self Serve Business".
const words = (value: string): string =>
  value
    .split(/[_\s-]+/)
    .filter((word) => word.length > 0)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ')

const multiplierOf = (said: string): string | null => {
  if (said.includes('20x')) return '20x'
  if (said.includes('5x')) return '5x'
  return null
}

export const planLabel = (kind: SeatKind, plan: string | null, rateLimitTier: string | null): string | null => {
  // The vendor prefix says nothing the provider beside it does not.
  const bare = lower(plan).replace(/^(claude|codex)_/, '')
  const said = `${bare} ${lower(rateLimitTier)}`
  const multiplier = multiplierOf(said)
  // `prolite` before `pro`, which it starts with.
  if (kind === 'codex' && bare.startsWith('prolite')) return 'Pro 5x'
  if (kind === 'codex' && bare.startsWith('pro')) return `Pro ${multiplier === null ? '20x' : multiplier}`
  if (said.includes('max')) return multiplier === null ? 'Max' : `Max ${multiplier}`
  return bare.length === 0 ? null : words(bare)
}
