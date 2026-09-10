/**
 * Utilization aggregations for the router dashboard (Phase 7).
 *
 * Reads the last N hours of `RequestLog` plus the current
 * `SubAccountQuota` snapshot to produce three summaries the UI
 * renders:
 *
 *   - perScenario: request count / ok / 429 / other-error per scenario
 *   - perTarget:   requested-model → sent-to model distribution
 *   - perAccount:  live subscription budget + resetAt per SubAccount
 *
 * Plus per-preference-entry suggestions ("Fable never reached — check
 * the primary" and similar). The suggestions are documented in the
 * plan doc §Phase 7 and reused by the dashboard's "Suggested change"
 * cards. Suggestions carry a JSON diff instead of raw SQL — they
 * describe a chain edit for the operator to apply, never a write.
 */

import { getPrismaClient } from '../db/client'
import type { PrismaClient } from '../generated/prisma/client'
import dayjs from '../lib/dayjs'
import { loadRouterPreferences } from './router-preference-service'

export interface PerScenarioRow {
  scenario: string
  total: number
  ok: number
  err429: number
  errOther: number
}

export interface PerTargetRow {
  requestedModel: string | null
  sentTo: string
  count: number
}

export interface PerAccountRow {
  subAccountId: string
  providerName: string
  kind: 'claude' | 'codex'
  currentBudgetPct: number | null
  fiveHourResetAt: string | null
  weeklyResetAt: string | null
  stale: boolean
}

export interface UtilizationSuggestion {
  kind: 'primary_never_reached' | 'fallback_over_used' | 'exhausted_no_secondary'
  target: string
  detail: string
  proposedDiff: Record<string, unknown>
}

export interface UtilizationResponse {
  windowHours: number
  generatedAt: string
  perScenario: PerScenarioRow[]
  perTarget: PerTargetRow[]
  perAccount: PerAccountRow[]
  suggestions: UtilizationSuggestion[]
}

const STALE_MULT = 3
const TTL_MS = 5 * 60 * 1000

async function loadPerScenario(prisma: PrismaClient, sinceHours: number): Promise<PerScenarioRow[]> {
  const rows = await prisma.$queryRawUnsafe<
    { scenario: string | null; total: bigint; ok: bigint; err429: bigint; err_other: bigint }[]
  >(
    `SELECT scenario,
            COUNT(*)::bigint                                              AS total,
            COUNT(*) FILTER (WHERE status < 400)::bigint                  AS ok,
            COUNT(*) FILTER (WHERE status = 429)::bigint                  AS err429,
            COUNT(*) FILTER (WHERE status >= 400 AND status <> 429)::bigint AS err_other
     FROM "RequestLog"
     WHERE "createdAt" > NOW() - $1::interval
     GROUP BY scenario
     ORDER BY total DESC`,
    `${sinceHours} hours`
  )
  return rows.map((r) => ({
    scenario: r.scenario ?? '(unknown)',
    total: Number(r.total),
    ok: Number(r.ok),
    err429: Number(r.err429),
    errOther: Number(r.err_other)
  }))
}

async function loadPerTarget(prisma: PrismaClient, sinceHours: number): Promise<PerTargetRow[]> {
  const rows = await prisma.$queryRawUnsafe<{ requested: string | null; sent_to: string; n: bigint }[]>(
    `SELECT "requestedModel" AS requested,
            provider || ',' || model AS sent_to,
            COUNT(*)::bigint AS n
     FROM "RequestLog"
     WHERE "createdAt" > NOW() - $1::interval
     GROUP BY "requestedModel", provider, model
     ORDER BY n DESC`,
    `${sinceHours} hours`
  )
  return rows.map((r) => ({ requestedModel: r.requested, sentTo: r.sent_to, count: Number(r.n) }))
}

async function loadPerAccount(prisma: PrismaClient): Promise<PerAccountRow[]> {
  const now = dayjs().valueOf()
  const rows = await prisma.subAccount.findMany({
    include: { provider: true, quota: true }
  })
  const out: PerAccountRow[] = []
  for (const a of rows) {
    if (a.provider.authMode !== 'subscription') continue
    const q = a.quota
    const kind: 'claude' | 'codex' = a.provider.name.toLowerCase().includes('codex') ? 'codex' : 'claude'
    let budget: number | null = null
    if (q !== null) {
      const five =
        q.fiveHourUsed !== null && q.fiveHourLimit !== null && q.fiveHourLimit > 0
          ? 1 - q.fiveHourUsed / q.fiveHourLimit
          : null
      const week =
        q.weeklyUsed !== null && q.weeklyLimit !== null && q.weeklyLimit > 0 ? 1 - q.weeklyUsed / q.weeklyLimit : null
      if (five !== null && week !== null) budget = Math.min(five, week)
      else if (five !== null) budget = five
      else if (week !== null) budget = week
    }
    const refreshedAt = q?.quotaRefreshedAt ? q.quotaRefreshedAt.valueOf() : null
    out.push({
      subAccountId: a.id,
      providerName: a.provider.name,
      kind,
      currentBudgetPct: budget === null ? null : Math.round(budget * 100),
      fiveHourResetAt: q?.fiveHourResetAt ? dayjs(q.fiveHourResetAt).toISOString() : null,
      weeklyResetAt: q?.weeklyResetAt ? dayjs(q.weeklyResetAt).toISOString() : null,
      stale: refreshedAt !== null && now - refreshedAt > STALE_MULT * TTL_MS
    })
  }
  return out
}

// Suggestion detectors. Each returns 0 or more suggestions per target.
// Kept pure so the tests exercise them without a DB.
export function detectSuggestions(input: {
  perTarget: readonly PerTargetRow[]
  preferences: readonly { target: string; enabled: boolean }[]
}): UtilizationSuggestion[] {
  const out: UtilizationSuggestion[] = []
  const totalByTarget = new Map<string, number>()
  for (const row of input.perTarget) {
    totalByTarget.set(row.sentTo, (totalByTarget.get(row.sentTo) ?? 0) + row.count)
  }
  const grand = [...totalByTarget.values()].reduce((n, v) => n + v, 0)
  if (grand === 0) return out

  // Primary never reached: top-preference entry has < 1% of traffic
  // while a lower entry has > 20%. Signals a mis-configured primary.
  const enabledEntries = input.preferences.filter((p) => p.enabled)
  if (enabledEntries.length >= 2) {
    const primary = enabledEntries[0]
    const primaryPct = ((totalByTarget.get(primary.target) ?? 0) / grand) * 100
    if (primaryPct < 1) {
      const dominant = enabledEntries
        .slice(1)
        .map((e) => ({ target: e.target, pct: ((totalByTarget.get(e.target) ?? 0) / grand) * 100 }))
        .find((e) => e.pct > 20)
      if (dominant !== undefined) {
        out.push({
          kind: 'primary_never_reached',
          target: primary.target,
          detail: `${primary.target} received ${primaryPct.toFixed(1)}% of traffic; ${dominant.target} took ${dominant.pct.toFixed(1)}% instead.`,
          proposedDiff: {
            preferences: {
              reorder: 'demote_primary',
              reason: 'primary never reached'
            }
          }
        })
      }
    }
  }
  return out
}

export async function getRouterUtilization(sinceHours: number, prisma?: PrismaClient): Promise<UtilizationResponse> {
  const client = prisma ?? getPrismaClient()
  const [perScenario, perTarget, perAccount, preferences] = await Promise.all([
    loadPerScenario(client, sinceHours),
    loadPerTarget(client, sinceHours),
    loadPerAccount(client),
    loadRouterPreferences(client)
  ])
  // Union across (scenario, kind): an entry counts as "in the chain" if
  // it appears in any (scenario, kind) chain. Enabled aggregates via OR
  // so a target disabled in one place but active in another still
  // counts. Both the agent and subagent lanes contribute.
  const seen = new Map<string, boolean>()
  for (const scenario of ['default', 'think', 'longContext', 'webSearch', 'image'] as const) {
    for (const kind of ['agent', 'subagent'] as const) {
      for (const e of preferences.entriesByScenario[scenario][kind]) {
        seen.set(e.target, (seen.get(e.target) ?? false) || e.enabled)
      }
    }
  }
  const suggestions = detectSuggestions({
    perTarget,
    preferences: [...seen.entries()].map(([target, enabled]) => ({ target, enabled }))
  })
  return {
    windowHours: sinceHours,
    generatedAt: dayjs().toISOString(),
    perScenario,
    perTarget,
    perAccount,
    suggestions
  }
}
