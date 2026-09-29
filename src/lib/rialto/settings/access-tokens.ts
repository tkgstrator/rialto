/**
 * Wire shape and pure state logic for the access-token list.
 *
 * The one rule worth stating: a listed token is dead once its expiry has
 * passed, even though its row is still there. `resolveAccessToken`
 * rejects it (`expiresAt === null || expiresAt > now`), so a UI that only
 * asked "is it listed" would show an expired credential as live — the
 * exact wrong answer on a screen whose job is to say what can still
 * reach the proxy. A revoked token is simply not listed: revoking deletes
 * the row.
 */

import type { AccessTokenWire } from '@/lib/api'
import dayjs from '@/lib/dayjs'
import { fmtTokens } from '@/lib/sessions/format'

export type { AccessTokenWire } from '@/lib/api'

/**
 * A windowed token count, or the dash for one the window cannot answer.
 *
 * Shared with the detail page for the same reason `TOKEN_STATE_PILL` is:
 * the row and the token's own page show the same figure, and the absent
 * case is exactly where two copies drift. The dash is the one `fmtCost`
 * prints, so Cost / In / Out say "nothing to show" identically.
 */
export function fmtTokenCount(n: number | null): string {
  return n === null ? '–' : fmtTokens(n)
}

export type TokenState = 'active' | 'expired'

/** Mirrors the server's accept test, so the badge cannot disagree with the gate. */
export function tokenState(token: AccessTokenWire, now: number): TokenState {
  if (token.expiresAt !== null && Date.parse(token.expiresAt) <= now) return 'expired'
  return 'active'
}

/**
 * How each state paints. Shared rather than local to the table because
 * the detail page shows the same badge for the same token, and two
 * copies of this map is exactly how a row and its own page end up
 * disagreeing about whether a credential is live.
 */
export const TOKEN_STATE_PILL: Record<TokenState, { tone: 'ok' | 'warn' | 'bad'; labelKey: string }> = {
  active: { tone: 'ok', labelKey: 'settings.access.tokenActive' },
  expired: { tone: 'warn', labelKey: 'settings.access.tokenExpired' }
}

export interface TokenCounts {
  active: number
  expired: number
}

export function countTokens(tokens: readonly AccessTokenWire[], now: number): TokenCounts {
  const counts: TokenCounts = { active: 0, expired: 0 }
  for (const token of tokens) {
    const state = tokenState(token, now)
    counts[state] += 1
  }
  return counts
}

const STATE_ORDER: Record<TokenState, number> = { active: 0, expired: 1 }

/**
 * Live credentials first, expired ones at the bottom — not what someone
 * scanning this table is looking for. Ties break on newest first.
 */
export function sortTokens(tokens: readonly AccessTokenWire[], now: number): AccessTokenWire[] {
  return [...tokens].sort((a, b) => {
    const byState = STATE_ORDER[tokenState(a, now)] - STATE_ORDER[tokenState(b, now)]
    if (byState !== 0) return byState
    return Date.parse(b.createdAt) - Date.parse(a.createdAt)
  })
}

export interface ExpiryChoice {
  id: string
  labelKey: string
  days: number | null
}

/**
 * Offered lifetimes. `never` is first because it is what most local
 * setups want, but a bounded token is the safer default for anything
 * leaving the machine — hence the explicit choices rather than a
 * free-text date.
 */
export const EXPIRY_CHOICES: readonly ExpiryChoice[] = [
  { id: 'never', labelKey: 'settings.access.expiryNever', days: null },
  { id: '30d', labelKey: 'settings.access.expiry30d', days: 30 },
  { id: '90d', labelKey: 'settings.access.expiry90d', days: 90 },
  { id: '365d', labelKey: 'settings.access.expiry365d', days: 365 }
]

/** Resolve a choice id to the ISO instant the issue call wants, or null. */
export function expiryToIso(choiceId: string, now: number): string | null {
  const choice = EXPIRY_CHOICES.find((c) => c.id === choiceId)
  if (choice === undefined || choice.days === null) return null
  return dayjs(now).add(choice.days, 'day').toISOString()
}
