/**
 * Phase 1 collector for the quota-aware preference router.
 *
 * Reads the same TTL-cached usage snapshot the existing usage-history job
 * already fetches (5-min TTL in `usage-service/cache.ts`), maps each
 * account's window state into the horizontal `SubAccountQuota` shape, and
 * upserts one row per SubAccount. No routing behaviour changes yet — this
 * is purely data collection so the Phase 2 scheduler and Phase 3 selector
 * have a warm table to read from.
 *
 * Design notes:
 *   - We reuse `fetchUsageSnapshotWithAccountIds` so upstream fetches are
 *     shared with the existing usage-history pipeline. Adding this hook
 *     does NOT double the poll load on Anthropic / OpenAI.
 *   - Mapping functions are pure and exported so the collector test can
 *     drive them from fixtures without a DB or the network.
 *   - Never throws. Per-account failures are logged and counted; the
 *     account keeps its previous row so `quotaRefreshedAt` staleness is
 *     the sole signal of a broken account.
 */

import { getPrismaClient } from '../../db/client'
import { Prisma } from '../../generated/prisma/client'
import dayjs from '../../lib/dayjs'
import { logger } from '../../logger'
import type { ClaudeUsage, CodexUsage } from '../../schemas/api/usage'
import { fetchUsageSnapshotWithAccountIds } from '../usage-service'

export interface CollectorResult {
  refreshed: number
  failed: number
}

// Anthropic publishes the 5-hour rolling window as a fixed 5h window;
// the wire schema does not carry `limit_window_seconds`. Fix it here so
// `drainTarget()` and similar helpers do not have to guess later.
const CLAUDE_FIVE_HOUR_SECONDS = 5 * 60 * 60
const CLAUDE_WEEKLY_SECONDS = 7 * 24 * 60 * 60

// Fixed pct-based unit convention (see the schema comment on
// `SubAccountQuota`): upstreams only report percentages today, so we
// store `used = utilization` and `limit = 100`. Future absolute-count
// sources reuse the same columns with a different ratio.
const PCT_LIMIT = 100

interface QuotaUpdate {
  fiveHourUsed: number | null
  fiveHourLimit: number | null
  fiveHourResetAt: Date | null
  fiveHourWindowSeconds: number | null
  weeklyUsed: number | null
  weeklyLimit: number | null
  weeklyResetAt: Date | null
  weeklyWindowSeconds: number | null
  scopedWindows: Prisma.InputJsonValue | typeof Prisma.JsonNull
  // Codex only; a Claude reading leaves them out, so the columns keep
  // whatever they held (null for a Claude account).
  resetCreditsAvailable?: number | null
  resetCreditsApplicable?: number | null
  quotaRefreshedAt: Date
}

const toDate = (iso: string | null | undefined): Date | null => {
  if (iso === null || iso === undefined) return null
  const d = dayjs(iso)
  return d.isValid() ? d.toDate() : null
}

const numberOrNull = (v: number | null | undefined): number | null => (typeof v === 'number' ? v : null)

// Convert a per-model display_name into the slug used as the
// `scopedWindows` JSONB key. Mirrors the trailing segment of
// `scopedMetricKey` in `subaccount-usage-store.ts` — kept as a small
// inline function here (instead of importing) to keep this module free
// of cross-service imports whose ordering can trip Bun's TS parser.
const modelSlug = (modelName: string): string => modelName.toLowerCase().replace(/[^a-z0-9]+/g, '_')

// Serialise Claude per-model weekly windows into the JSONB shape the
// schema comment documents:
//   { "<slug>": { "used": <pct>, "limit": 100, "resetAt": "<iso>" | null } }
// Returns `Prisma.JsonNull` (not SQL NULL) when the source list is
// empty, so the column round-trips as JSON null rather than being
// unset entirely.
const scopedWindowsFor = (
  scoped: readonly ClaudeUsage['weeklyScoped'][number][]
): Prisma.InputJsonValue | typeof Prisma.JsonNull => {
  if (scoped.length === 0) return Prisma.JsonNull
  const out: Record<string, { used: number; limit: number; resetAt: string | null }> = {}
  for (const s of scoped) {
    out[modelSlug(s.modelName)] = { used: s.utilization, limit: PCT_LIMIT, resetAt: s.resetsAt }
  }
  return out
}

// Pure. Maps a fetched Claude usage snapshot into the SubAccountQuota
// update payload. `now` is injected so tests are deterministic.
export function mapClaudeToQuota(usage: ClaudeUsage, now: Date): QuotaUpdate {
  return {
    fiveHourUsed: numberOrNull(usage.fiveHour?.utilization),
    fiveHourLimit: usage.fiveHour ? PCT_LIMIT : null,
    fiveHourResetAt: toDate(usage.fiveHour?.resetsAt),
    fiveHourWindowSeconds: usage.fiveHour ? CLAUDE_FIVE_HOUR_SECONDS : null,
    weeklyUsed: numberOrNull(usage.sevenDay?.utilization),
    weeklyLimit: usage.sevenDay ? PCT_LIMIT : null,
    weeklyResetAt: toDate(usage.sevenDay?.resetsAt),
    weeklyWindowSeconds: usage.sevenDay ? CLAUDE_WEEKLY_SECONDS : null,
    scopedWindows: scopedWindowsFor(usage.weeklyScoped),
    quotaRefreshedAt: now
  }
}

// Pure. Maps a fetched Codex usage snapshot into the SubAccountQuota
// update payload. Uses the wire-value `windowSeconds` from each Codex
// window when present; Claude's 5h/weekly window lengths are constants.
export function mapCodexToQuota(usage: CodexUsage, now: Date): QuotaUpdate {
  // Absent (not just null) on a reading built before the field existed.
  const credits = usage.resetCredits === undefined ? null : usage.resetCredits
  return {
    fiveHourUsed: numberOrNull(usage.primary?.usedPercent),
    fiveHourLimit: usage.primary ? PCT_LIMIT : null,
    fiveHourResetAt: toDate(usage.primary?.resetAt),
    fiveHourWindowSeconds: numberOrNull(usage.primary?.windowSeconds),
    weeklyUsed: numberOrNull(usage.secondary?.usedPercent),
    weeklyLimit: usage.secondary ? PCT_LIMIT : null,
    weeklyResetAt: toDate(usage.secondary?.resetAt),
    weeklyWindowSeconds: numberOrNull(usage.secondary?.windowSeconds),
    // Codex has no per-model weekly windows.
    scopedWindows: Prisma.JsonNull,
    resetCreditsAvailable: credits === null ? null : credits.available,
    resetCreditsApplicable: credits === null ? null : credits.applicable,
    quotaRefreshedAt: now
  }
}

// Upsert one SubAccountQuota row. Returns true on success, false when
// the write threw (e.g. the SubAccount was deleted between the usage
// fetch and this write). Never propagates the error.
async function upsertOne(subAccountId: string, data: QuotaUpdate, prisma = getPrismaClient()): Promise<boolean> {
  try {
    await prisma.subAccountQuota.upsert({
      where: { subAccountId },
      create: { subAccountId, ...data },
      update: data
    })
    return true
  } catch (err) {
    logger.warn({ err, subAccountId }, '[routing-scheduler] SubAccountQuota upsert failed')
    return false
  }
}

export interface CollectorInput {
  claude?: ReadonlyArray<{ subAccountId: string; usage: ClaudeUsage }>
  codex?: ReadonlyArray<{ subAccountId: string; usage: CodexUsage }>
}

// Phase 1 entry point. Called from
// `usage-history-service.recordUsageSnapshots` once per usage-job tick so
// SubAccountQuota is filled without needing the Phase 2 scheduler.
// Reuses the already-cached snapshot — no extra upstream fetches.
//
// When `input` is omitted, the collector calls
// `fetchUsageSnapshotWithAccountIds()` itself. When it is provided (the
// usage-job path), pass the already-fetched arrays through to avoid a
// redundant snapshot pull.
export async function refreshQuotaSnapshots(
  input?: CollectorInput,
  prisma = getPrismaClient()
): Promise<CollectorResult> {
  const claude = input?.claude
  const codex = input?.codex
  const paired =
    claude !== undefined || codex !== undefined
      ? { claude: claude ? claude : [], codex: codex ? codex : [] }
      : await fetchUsageSnapshotWithAccountIds().catch((err) => {
          logger.warn({ err }, '[routing-scheduler] fetchUsageSnapshotWithAccountIds failed')
          return { claude: [] as CollectorInput['claude'] extends undefined ? never : never[], codex: [] as never[] }
        })
  const now = dayjs().toDate()
  const out: CollectorResult = { refreshed: 0, failed: 0 }
  for (const c of paired.claude) {
    const ok = await upsertOne(c.subAccountId, mapClaudeToQuota(c.usage, now), prisma)
    if (ok) out.refreshed += 1
    else out.failed += 1
  }
  for (const x of paired.codex) {
    const ok = await upsertOne(x.subAccountId, mapCodexToQuota(x.usage, now), prisma)
    if (ok) out.refreshed += 1
    else out.failed += 1
  }
  return out
}
