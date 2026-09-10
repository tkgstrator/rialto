/**
 * The Subscriptions list's Refresh button, server side.
 *
 * The quota column reads `SubAccountQuota`, which the usage job rewrites
 * on the wall-clock five-minute marks from a usage snapshot that is itself
 * cached for five minutes (`usage-service/cache.ts`). A manual refresh
 * short-circuits both: it re-syncs every account's profile the way
 * POST /api/subscriptions/sync does, polls usage past the cache, and
 * rewrites the two current-state tables — `SubAccountUsage`, which the
 * account picker reads, and `SubAccountQuota`, which the list and the
 * scheduler read — so the bars move now rather than at the next tick.
 *
 * What it deliberately leaves alone:
 *   - `UsageSnapshot`. The Usage chart's samples sit on the poller's
 *     5-minute grid, one capture per pivot timestamp. A sample written
 *     between ticks would land off-grid or share a pivot with the next
 *     tick's rows and be averaged into them; the chart is a history, and
 *     a click is not an event in it.
 *   - Accounts on disabled providers. Nothing routes to them, so the
 *     upstream calls would buy nothing the list can show as live.
 *   - Rows for an account whose upstream call failed. The poller keeps
 *     writing the last cached value in that case; here the operator has
 *     just been told the account could not be refreshed, and a
 *     `quotaRefreshedAt` of now under that toast would say the opposite.
 *
 * Concurrent calls share one run. The button is disabled while a refresh
 * is pending, but two tabs or a script can still fire together, and the
 * usage endpoints are undocumented side channels with no published limit
 * — coalescing is the cheapest way to make N clicks cost one pass.
 */

import { getPrismaClient } from '../db/client'
import { AuthMode, type PrismaClient } from '../generated/prisma/client'
import { logger } from '../logger'
import type { SubscriptionRefreshResponse } from '../schemas/api/subscriptions'
import { refreshQuotaSnapshots } from './routing-scheduler/collector'
import { recordPerAccountUsage } from './subaccount-usage-store'
import { syncSubAccountProfiles } from './subscription-account-sync-service'
import { fetchUsageSnapshotWithAccountIds } from './usage-service'

const inflight: { run: Promise<SubscriptionRefreshResponse> | null } = { run: null }

async function runRefresh(prisma: PrismaClient): Promise<SubscriptionRefreshResponse> {
  // The roster is read first so `attempted` is the set both stages were
  // pointed at, and so an account that fails still has a label to be
  // reported under.
  const roster = await prisma.subAccount.findMany({
    where: { provider: { authMode: AuthMode.subscription, enabled: true } },
    select: { id: true, label: true, provider: { select: { name: true } } },
    orderBy: [{ provider: { name: 'asc' } }, { id: 'asc' }]
  })

  const profiles = await syncSubAccountProfiles(prisma, { enabledProvidersOnly: true })
  const usage = await fetchUsageSnapshotWithAccountIds({ forceRefresh: true })

  const usageFailed = new Set(usage.failed)
  const fresh = {
    claude: usage.claude.filter((c) => !usageFailed.has(c.subAccountId)),
    codex: usage.codex.filter((x) => !usageFailed.has(x.subAccountId))
  }
  await recordPerAccountUsage(fresh.claude, fresh.codex, prisma)
  const quota = await refreshQuotaSnapshots(fresh, prisma)
  if (quota.failed > 0) {
    logger.warn(quota, '[subscriptions] refresh: SubAccountQuota upsert failed for some accounts')
  }

  const failedIds = new Set([...profiles.failedAccountIds, ...usage.failed])
  const failed = roster
    .filter((account) => failedIds.has(account.id))
    .map((account) => ({ subAccountId: account.id, label: account.label, providerName: account.provider.name }))
  return { attempted: roster.length, refreshed: roster.length - failed.length, failed }
}

export function refreshSubscriptions(prisma: PrismaClient = getPrismaClient()): Promise<SubscriptionRefreshResponse> {
  if (inflight.run !== null) return inflight.run
  const run = runRefresh(prisma).finally(() => {
    inflight.run = null
  })
  inflight.run = run
  return run
}
