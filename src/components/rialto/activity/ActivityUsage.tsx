/**
 * Activity › Usage — where the subscription windows have been, and whose
 * traffic put them there.
 *
 * The fourth Activity tab because that is where the pre-Rialto `/usage`
 * screen was folded (`NotFound`'s MERGED_INTO has said so since the
 * refactor) and the answer it gives is a time series, which the other
 * three tabs are not shaped to hold.
 *
 * The split against Overview is load-bearing, not cosmetic. Overview
 * answers "where does this stand right now" with the account-wide 5h/7d
 * meters. This screen answers the two questions that need history or a
 * breakdown: how the windows got here, and which credential spent the
 * money. Both were served by endpoints the UI had never called
 * (`/api/usage`, `/api/usage/history`), and the per-model weekly windows
 * — the limit that actually stops a Fable request — were visible nowhere.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  fetchSubscriptions,
  fetchUsage,
  fetchUsageHistory,
  type UsageCostResponse
} from '@/components/rialto/activity/data'
import { FilterSelect, ScreenMessage } from '@/components/rialto/activity/shared'
import { UtilizationChart } from '@/components/rialto/activity/UsagePaceChart'
import { TokenRow } from '@/components/rialto/activity/UsageTokens'
import { ProviderGroup } from '@/components/rialto/activity/UsageWindows'
import {
  type AccountUsageIndex,
  bucketSamples,
  indexAccountUsage,
  providerWindows,
  seriesOf,
  tokenUsageRows,
  type UsageHistorySample,
  type UsageWire
} from '@/components/rialto/activity/usage-derive'
import { useActivityCounts } from '@/components/rialto/activity/use-activity-counts'
import { RButton } from '@/components/rialto/primitives'
import type { SubscriptionsResponse, SubscriptionWire } from '@/components/rialto/providers/types'
import { Screen } from '@/components/rialto/Screen'
import { type AccessTokenWire, api, type InboundSurfaceWire } from '@/lib/api'

// Ranges the history endpoint accepts (it caps `days` at 30). Offered as a
// real control rather than an ornament: a week answers "did I spike", a
// month answers "is this the normal shape".
const RANGE_DAYS = [7, 14, 30] as const
const DEFAULT_RANGE_DAYS = 7
// The collector samples every five minutes; plot no more points than pixels can distinguish.
const CHART_BUCKETS = 120

const EMPTY_SUBSCRIPTIONS: SubscriptionsResponse = { subscriptions: [] }

// The meta beside a title is the range the section covers, and only that.
// Where the numbers came from is not something the reader acts on.
function SectionHead({ title, meta, action }: { title: string; meta?: string; action?: React.ReactNode }) {
  return (
    <div className='flex items-baseline gap-3 border-t border-border px-6 pt-6 pb-3'>
      <h2 className='text-sm font-semibold'>{title}</h2>
      {meta === undefined ? null : <span className='text-xs text-muted-foreground/70'>{meta}</span>}
      {action === undefined ? null : <div className='ml-auto'>{action}</div>}
    </div>
  )
}

/** All three panels' fetches. Kept out of the screen so it stays a layout. */
function useUsageData(days: number) {
  const [usage, setUsage] = useState<UsageWire | null>(null)
  const [accountUsage, setAccountUsage] = useState<AccountUsageIndex>(new Map())
  const [subscriptions, setSubscriptions] = useState<SubscriptionWire[]>([])
  const [samples, setSamples] = useState<UsageHistorySample[]>([])
  const [tokens, setTokens] = useState<AccessTokenWire[]>([])
  const [surfaces, setSurfaces] = useState<InboundSurfaceWire[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)

    Promise.all([
      fetchUsage(),
      fetchUsageHistory(days),
      api.getAccessTokens(),
      api.getInboundSurfaces(),
      // Grouping and plan names only. A failed read leaves each account
      // under its vendor rather than taking the whole screen down with it.
      fetchSubscriptions().catch(() => EMPTY_SUBSCRIPTIONS),
      // The API-equivalent figures, which only Overview's quota rows carry
      // — the same read a subscription provider's page makes. Optional
      // like the subscriptions: without it the accounts lose those lines,
      // not their windows.
      api.getOverview({ windowHours: 24 }).catch(() => null)
    ])
      .then(([usageRes, historyRes, tokenRes, surfaceRes, subscriptionRes, overviewRes]) => {
        setUsage(usageRes)
        setAccountUsage(indexAccountUsage(overviewRes === null ? [] : overviewRes.quota))
        setSubscriptions(subscriptionRes.subscriptions)
        setSamples(historyRes.samples)
        setTokens(tokenRes.tokens)
        setSurfaces(surfaceRes.surfaces)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [days])

  useEffect(load, [load])

  return { usage, accountUsage, subscriptions, samples, tokens, surfaces, error, loading, reload: load }
}

export function ActivityUsage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const _counts = useActivityCounts()
  const [days, setDays] = useState<number>(DEFAULT_RANGE_DAYS)
  const { usage, accountUsage, subscriptions, samples, tokens, surfaces, error, loading, reload } = useUsageData(days)
  // One clock for the whole render, so two rows cannot disagree about how
  // long until the same reset.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const groups = useMemo(
    () => (usage === null ? [] : providerWindows(usage, subscriptions, t)),
    [usage, subscriptions, t]
  )
  const accountTotal = groups.reduce((sum, group) => sum + group.accounts.length, 0)
  const series = useMemo(() => seriesOf(samples, t), [samples, t])
  const points = useMemo(() => bucketSamples(samples, CHART_BUCKETS), [samples])
  const rows = useMemo(() => tokenUsageRows(tokens), [tokens])

  const refresh = useCallback(() => {
    reload()
    toast.success(t('activity.usage.refreshed'))
  }, [reload, t])

  return (
    <Screen
      subtitle={t('activity.usage.subtitle', { accounts: accountTotal, days })}
      actions={
        <RButton variant='outline' icon='ri-refresh-line' onClick={refresh} disabled={loading}>
          {t('activity.usage.refresh')}
        </RButton>
      }
    >
      {/* The range and nothing beside it: the section heads already say
          what each part of the screen answers. */}
      <div className='flex flex-wrap items-center gap-2 border-b border-border px-6 py-3'>
        <FilterSelect
          label={t('activity.usage.range')}
          value={String(days)}
          options={RANGE_DAYS.map((n) => ({ id: String(n), label: t('activity.usage.rangeDays', { n }) }))}
          onChange={(id) => setDays(Number.parseInt(id, 10))}
        />
      </div>

      {error !== null ? <ScreenMessage tone='bad'>{error}</ScreenMessage> : null}

      <SectionHead title={t('activity.usage.windowsTitle')} />
      {groups.length === 0 ? (
        <ScreenMessage>{loading ? t('common.loading') : t('activity.usage.noAccounts')}</ScreenMessage>
      ) : (
        <div className='pb-2'>
          {groups.map((group) => (
            <ProviderGroup key={group.key} group={group} accountUsage={accountUsage} now={now} />
          ))}
        </div>
      )}

      {/* No Export CSV: the chart is read here, and the screens hand out
          no files. */}
      <SectionHead title={t('activity.usage.chartTitle')} meta={t('activity.usage.chartMeta', { days })} />
      {points.length === 0 ? (
        <ScreenMessage>{loading ? t('common.loading') : t('activity.usage.noHistory')}</ScreenMessage>
      ) : (
        <UtilizationChart points={points} series={series} />
      )}

      <SectionHead
        title={t('activity.usage.tokensTitle')}
        meta={t('activity.usage.tokensMeta')}
        action={
          <RButton variant='ghost' icon='ri-key-2-line' onClick={() => navigate('/access-tokens')}>
            {t('activity.usage.manageTokens')}
          </RButton>
        }
      />
      {rows.length === 0 ? (
        <ScreenMessage>{loading ? t('common.loading') : t('activity.usage.noTokens')}</ScreenMessage>
      ) : (
        <table className='w-full table-fixed'>
          <colgroup>
            <col />
            <col className='w-40' />
            <col className='w-24' />
            <col className='w-24' />
            <col className='w-40' />
            <col className='w-28' />
          </colgroup>
          <thead>
            <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2'>
              <th className='pl-6 pr-3 text-left font-medium'>{t('settings.access.colToken')}</th>
              <th className='px-3 text-left font-medium'>{t('settings.access.colEndpoint')}</th>
              <th className='px-3 text-right font-medium'>{t('settings.access.colRequests')}</th>
              <th className='px-3 text-right font-medium'>{t('settings.access.colCost')}</th>
              <th className='px-3 text-left font-medium'>{t('activity.usage.colShare')}</th>
              <th className='whitespace-nowrap pl-3 pr-6 text-right font-medium'>{t('settings.access.colLastUsed')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <TokenRow key={row.id} row={row} surfaces={surfaces} now={now} />
            ))}
          </tbody>
        </table>
      )}
      <div className='h-10' />
    </Screen>
  )
}

// Re-exported so the screen module owns one public name, matching the
// other three Activity screens.
export type { UsageCostResponse }
