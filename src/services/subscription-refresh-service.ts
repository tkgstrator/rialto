/**
 * The account half of the Providers screens' Refresh, server side.
 *
 * The quota column reads `SubAccountQuota`, which the usage job rewrites
 * on the wall-clock five-minute marks from a usage snapshot that is itself
 * cached for five minutes (`usage-service/cache.ts`). A manual refresh
 * short-circuits both: it re-syncs each account's profile the way
 * POST /api/subscriptions/sync does, polls usage past the cache, and
 * rewrites the two current-state tables — `SubAccountUsage`, which the
 * account picker reads, and `SubAccountQuota`, which the list and the
 * scheduler read — so the bars move now rather than at the next tick.
 *
 * Two scopes. The Subscriptions list refreshes every account on an
 * enabled provider. A provider's own page refreshes that provider's
 * accounts, and does so while the provider is switched off: the page asks
 * about the provider it shows, and "do these credentials still work" is
 * the question asked right before switching one back on.
 *
 * What it deliberately leaves alone:
 *   - `UsageSnapshot`. The Usage chart's samples sit on the poller's
 *     5-minute grid, one capture per pivot timestamp. A sample written
 *     between ticks would land off-grid or share a pivot with the next
 *     tick's rows and be averaged into them; the chart is a history, and
 *     a click is not an event in it.
 *   - On the list's refresh, accounts on disabled providers. Nothing
 *     routes to them, so polling every one of them on every click would
 *     buy nothing the list can show as live.
 *   - Rows for an account whose upstream call failed. The poller keeps
 *     writing the last cached value in that case; here the operator has
 *     just been told the account could not be refreshed, and a
 *     `quotaRefreshedAt` of now under that toast would say the opposite.
 *
 * Concurrent calls for the same scope share one run. The button is
 * disabled while a refresh is pending, but two tabs or a script can still
 * fire together, and the usage endpoints are undocumented side channels
 * with no published limit — coalescing is the cheapest way to make N
 * clicks cost one pass.
 */

import { getPrismaClient } from '../db/client'
import { AuthMode, type Prisma, type PrismaClient } from '../generated/prisma/client'
import { logger } from '../logger'
import type { SubscriptionRefreshResponse } from '../schemas/api/subscriptions'
import { refreshQuotaSnapshots } from './routing-scheduler/collector'
import { recordPerAccountUsage } from './subaccount-usage-store'
import {
  getSubAccountTokensForProvider,
  type ProfileSyncScope,
  syncSubAccountProfiles
} from './subscription-account-sync-service'
import { fetchUsageForAccounts, fetchUsageForTokens, fetchUsageSnapshotWithAccountIds } from './usage-service'

type AccountUsagePoll = Awaited<ReturnType<typeof fetchUsageSnapshotWithAccountIds>>

// The run in flight per scope, keyed `all` or `provider:<name>`.
const inflight = new Map<string, Promise<SubscriptionRefreshResponse>>()

function coalesce(
  scope: string,
  start: () => Promise<SubscriptionRefreshResponse>
): Promise<SubscriptionRefreshResponse> {
  const running = inflight.get(scope)
  if (running !== undefined) return running
  const run = start().finally(() => {
    inflight.delete(scope)
  })
  inflight.set(scope, run)
  return run
}

// Land a forced poll in the two current-state tables. An account whose
// upstream call failed is left out: its last cached value can still be in
// the poll result, and writing it would stamp a stale reading as fresh.
async function landFreshUsage(usage: AccountUsagePoll, prisma: PrismaClient): Promise<void> {
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
}

interface RefreshPlan {
  // The accounts `attempted` counts and a failure is named from.
  roster: Prisma.SubAccountWhereInput
  profiles: ProfileSyncScope
  // Called after the profile sync, which can rotate a token this poll is
  // about to send.
  poll: () => Promise<AccountUsagePoll>
}

async function runRefresh(plan: RefreshPlan, prisma: PrismaClient): Promise<SubscriptionRefreshResponse> {
  // The roster is read first so `attempted` is the set both stages were
  // pointed at, and so an account that fails still has a label to be
  // reported under.
  const roster = await prisma.subAccount.findMany({
    where: plan.roster,
    select: { id: true, label: true, provider: { select: { name: true } } },
    orderBy: [{ provider: { name: 'asc' } }, { id: 'asc' }]
  })

  const profiles = await syncSubAccountProfiles(prisma, plan.profiles)
  const usage = await plan.poll()
  await landFreshUsage(usage, prisma)

  const failedIds = new Set([...profiles.failedAccountIds, ...usage.failed])
  const failed = roster
    .filter((account) => failedIds.has(account.id))
    .map((account) => ({ subAccountId: account.id, label: account.label, providerName: account.provider.name }))
  return { attempted: roster.length, refreshed: roster.length - failed.length, failed }
}

/** Every account on an enabled subscription provider — the Subscriptions list. */
export function refreshSubscriptions(prisma: PrismaClient = getPrismaClient()): Promise<SubscriptionRefreshResponse> {
  return coalesce('all', () =>
    runRefresh(
      {
        roster: { provider: { authMode: AuthMode.subscription, enabled: true } },
        profiles: { enabledProvidersOnly: true },
        poll: () => fetchUsageSnapshotWithAccountIds({ forceRefresh: true })
      },
      prisma
    )
  )
}

/**
 * One subscription provider's accounts, switched on or not — the Refresh
 * on that provider's page. Null when no subscription provider has the
 * name, which the route answers as a 404 rather than as zero accounts: a
 * typo that reported "nothing to refresh" would read as a healthy result.
 */
export async function refreshProviderSubscriptions(
  providerName: string,
  prisma: PrismaClient = getPrismaClient()
): Promise<SubscriptionRefreshResponse | null> {
  const provider = await prisma.provider.findFirst({
    where: { name: providerName, authMode: AuthMode.subscription },
    select: { id: true }
  })
  if (provider === null) return null
  return coalesce(`provider:${providerName}`, () =>
    runRefresh(
      {
        roster: { providerId: provider.id },
        profiles: { providerName },
        poll: async () => {
          // A provider removed since the check above has nothing to poll.
          const tokens = await getSubAccountTokensForProvider(providerName, prisma)
          return fetchUsageForTokens(tokens === null ? { claude: [], codex: [] } : tokens)
        }
      },
      prisma
    )
  )
}

/**
 * Read the windows of accounts that were connected a moment ago, now.
 *
 * A new account used to show no quota until the next five-minute usage
 * tick. This is scoped to the named accounts rather than a full refresh:
 * their credentials were just verified, and a pass over every account
 * would spend the others' upstream calls for nothing. Returns the accounts
 * whose poll failed.
 */
export async function refreshAccountUsage(
  subAccountIds: readonly string[],
  prisma: PrismaClient = getPrismaClient()
): Promise<string[]> {
  const usage = await fetchUsageForAccounts(subAccountIds)
  await landFreshUsage(usage, prisma)
  return usage.failed
}
