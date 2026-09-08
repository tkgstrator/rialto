/**
 * Subscription accounts and the quota state the Overview tiles, the
 * Providers → Accounts panel and the Usage chart read.
 *
 * Everything here is additive. A real account keeps its own quota row —
 * the collector owns that, and overwriting it would make the router act
 * on invented numbers — so the seed only fills accounts and windows that
 * are still missing.
 */

import { AuthStatus, type PrismaClient } from '../../src/generated/prisma/client'
import { DEMO_PREFIX, demoId } from './demo-rows'
import type { Random } from './random'

type AccountKind = 'claude' | 'codex' | 'other'

// Same substring rule as subscription-info-service's providerKind, which
// is what the UI uses to label an account's vendor family.
const kindOf = (apiBaseUrl: string): AccountKind => {
  if (apiBaseUrl.includes('anthropic.com')) return 'claude'
  if (apiBaseUrl.includes('chatgpt.com') || apiBaseUrl.includes('openai.com/v1')) return 'codex'
  return 'other'
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

const PLAN_BY_KIND: Record<AccountKind, { plan: string; monthlyPriceUsd: number }> = {
  claude: { plan: 'claude_max', monthlyPriceUsd: 200 },
  codex: { plan: 'codex_pro', monthlyPriceUsd: 200 },
  other: { plan: 'unknown', monthlyPriceUsd: 20 }
}

export interface AccountsReport {
  createdAccounts: number
  createdQuotas: number
  createdUsageRows: number
  usageSnapshots: number
}

/**
 * Give every subscription provider an account when it has none, so the
 * Accounts panel and the quota tiles are not empty on a fresh install.
 * Providers that already have accounts are left exactly as they are.
 */
async function ensureAccounts(prisma: PrismaClient, now: number): Promise<number> {
  const providers = await prisma.provider.findMany({
    where: { authMode: 'subscription' },
    include: { subscriptionAccounts: { select: { id: true } } }
  })
  const missing = providers.filter((p) => p.subscriptionAccounts.length === 0)
  for (const [idx, provider] of missing.entries()) {
    const kind = kindOf(provider.apiBaseUrl)
    const plan = PLAN_BY_KIND[kind]
    const account = await prisma.subAccount.create({
      data: {
        id: demoId('acct', idx + 1),
        providerId: provider.id,
        // A path that cannot collide with a real credential file, so a
        // later sync never mistakes this row for one of its own.
        sourcePath: `~/.rialto/demo/${provider.name}.json`,
        enabled: true,
        label: `${provider.name}:demo`,
        userName: 'Demo Operator',
        userEmail: `demo@${provider.name}.invalid`,
        plan: plan.plan,
        rateLimitTier: 'default',
        // No token columns are written: the demo never authenticates,
        // and an empty ciphertext column is the honest representation.
        expiresAt: new Date(now + 6 * HOUR_MS),
        monthlyPriceUsd: plan.monthlyPriceUsd,
        authStatus: AuthStatus.live,
        authCheckedAt: new Date(now - 12 * 60_000),
        lastSyncedAt: new Date(now - 5 * 60_000)
      }
    })
    if (provider.activeSubscriptionAccountId === null) {
      await prisma.provider.update({
        where: { id: provider.id },
        data: { activeSubscriptionAccountId: account.id }
      })
    }
  }
  return missing.length
}

interface QuotaSeed {
  fiveHourUsed: number
  weeklyUsed: number
}

// One account is deliberately near its 5h ceiling and carries a recent
// 429, which is what puts a rate-limit row in Overview's failover feed.
const quotaSeedFor = (index: number, random: Random): QuotaSeed =>
  index === 0
    ? { fiveHourUsed: random.int(88, 97), weeklyUsed: random.int(55, 75) }
    : { fiveHourUsed: random.int(12, 55), weeklyUsed: random.int(8, 40) }

async function ensureQuotas(
  prisma: PrismaClient,
  random: Random,
  now: number
): Promise<{ quotas: number; usageRows: number }> {
  const accounts = await prisma.subAccount.findMany({
    include: { provider: { select: { apiBaseUrl: true } }, quota: { select: { id: true } } }
  })
  // Index within the accounts that still NEED a quota row, so the
  // near-exhausted account below is one the seed actually writes — on an
  // install whose collector already covers account 0, indexing the full
  // list would leave the 429 story untold.
  const needQuota = accounts.filter((a) => a.quota === null).map((a) => a.id)
  const counts = { quotas: 0, usageRows: 0 }

  for (const [idx, account] of accounts.entries()) {
    const quotaIdx = needQuota.indexOf(account.id)
    const kind = kindOf(account.provider.apiBaseUrl)
    const seed = quotaSeedFor(quotaIdx, random)
    const fiveHourResetAt = new Date(now + random.int(20, 260) * 60_000)
    const weeklyResetAt = new Date(now + random.int(1, 5) * DAY_MS)

    if (account.quota === null) {
      await prisma.subAccountQuota.create({
        data: {
          id: demoId('quota', idx + 1),
          subAccountId: account.id,
          fiveHourUsed: seed.fiveHourUsed,
          fiveHourLimit: 100,
          fiveHourResetAt,
          fiveHourWindowSeconds: 18_000,
          weeklyUsed: seed.weeklyUsed,
          weeklyLimit: 100,
          weeklyResetAt,
          weeklyWindowSeconds: 604_800,
          scopedWindows:
            kind === 'claude'
              ? {
                  fable: { used: random.int(5, 40), limit: 100, resetAt: weeklyResetAt.toISOString() },
                  opus: { used: random.int(10, 60), limit: 100, resetAt: weeklyResetAt.toISOString() }
                }
              : undefined,
          // Only the near-exhausted account carries the reactive 429 marks.
          lastRateLimitedAt: quotaIdx === 0 ? new Date(now - random.int(4, 40) * 60_000) : null,
          lastRateLimitStatus: quotaIdx === 0 ? 429 : null,
          lastRetryAfterSec: quotaIdx === 0 ? random.int(30, 900) : null,
          quotaRefreshedAt: new Date(now - random.int(1, 9) * 60_000)
        }
      })
      counts.quotas += 1
    }

    // Per-metric latest state. Unique on (subAccountId, metric), so an
    // account the poller already covers keeps its own rows.
    const metrics =
      kind === 'codex'
        ? [
            { metric: 'codex.primary', percent: seed.fiveHourUsed, resetAt: fiveHourResetAt },
            { metric: 'codex.secondary', percent: seed.weeklyUsed, resetAt: weeklyResetAt }
          ]
        : [
            { metric: 'claude.five_hour', percent: seed.fiveHourUsed, resetAt: fiveHourResetAt },
            { metric: 'claude.seven_day', percent: seed.weeklyUsed, resetAt: weeklyResetAt }
          ]
    for (const row of metrics) {
      const existing = await prisma.subAccountUsage.findUnique({
        where: { subAccountId_metric: { subAccountId: account.id, metric: row.metric } }
      })
      if (existing !== null) continue
      await prisma.subAccountUsage.create({
        data: { subAccountId: account.id, metric: row.metric, percent: row.percent, resetAt: row.resetAt }
      })
      counts.usageRows += 1
    }
  }
  return counts
}

// Utilization inside a rolling window: ramps toward the peak and drops
// back to near zero when the window rolls over. Real charts have that
// sawtooth, and a flat random walk reads as noise instead of usage.
const sawtooth = (elapsedMs: number, windowMs: number, peak: number, random: Random): number => {
  const phase = (elapsedMs % windowMs) / windowMs
  const jitter = random.int(-4, 4)
  return Math.min(100, Math.max(0, Math.round(phase * peak + jitter)))
}

/**
 * A week of hourly utilization history per metric, for the Usage chart.
 *
 * Only metrics with no recent samples are generated: on an install whose
 * poller is running, the real series is the interesting one, and a demo
 * series interleaved with it would be a lie about what the account did.
 */
async function ensureUsageHistory(prisma: PrismaClient, random: Random, now: number): Promise<number> {
  const accounts = await prisma.subAccount.findMany({ include: { provider: { select: { apiBaseUrl: true } } } })
  const kinds = new Set(accounts.map((a) => kindOf(a.provider.apiBaseUrl)))
  const series = [
    ...(kinds.has('claude')
      ? [
          { provider: 'claude', metric: 'claude.five_hour', windowMs: 5 * HOUR_MS, peak: 90 },
          { provider: 'claude', metric: 'claude.seven_day', windowMs: 7 * DAY_MS, peak: 70 }
        ]
      : []),
    ...(kinds.has('codex')
      ? [
          { provider: 'codex', metric: 'codex.primary', windowMs: 5 * HOUR_MS, peak: 85 },
          { provider: 'codex', metric: 'codex.secondary', windowMs: 7 * DAY_MS, peak: 60 }
        ]
      : [])
  ]

  const rows = []
  for (const [seriesIdx, s] of series.entries()) {
    const recent = await prisma.usageSnapshot.findFirst({
      where: { metric: s.metric, capturedAt: { gte: new Date(now - 2 * DAY_MS) } }
    })
    if (recent !== null) continue
    // 7 days at one sample an hour: enough for the chart's shape without
    // writing the poller's full 5-minute cadence.
    for (const hour of Array.from({ length: 7 * 24 }, (_, i) => i)) {
      const capturedAt = new Date(now - hour * HOUR_MS)
      rows.push({
        id: `${DEMO_PREFIX}snap-${seriesIdx}-${String(hour).padStart(4, '0')}`,
        provider: s.provider,
        metric: s.metric,
        percent: sawtooth(now - hour * HOUR_MS, s.windowMs, s.peak, random),
        resetAt: new Date(now + s.windowMs - ((now - hour * HOUR_MS) % s.windowMs)),
        capturedAt
      })
    }
  }
  if (rows.length > 0) await prisma.usageSnapshot.createMany({ data: rows })
  return rows.length
}

export async function seedAccounts(prisma: PrismaClient, random: Random, now: number): Promise<AccountsReport> {
  const createdAccounts = await ensureAccounts(prisma, now)
  const { quotas, usageRows } = await ensureQuotas(prisma, random, now)
  const usageSnapshots = await ensureUsageHistory(prisma, random, now)
  return { createdAccounts, createdQuotas: quotas, createdUsageRows: usageRows, usageSnapshots }
}
