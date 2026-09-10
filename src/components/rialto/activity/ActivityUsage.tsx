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
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { toast } from 'sonner'
import {
  fetchSubscriptions,
  fetchUsage,
  fetchUsageHistory,
  type UsageCostResponse
} from '@/components/rialto/activity/data'
import { FilterSelect, ScreenMessage } from '@/components/rialto/activity/shared'
import {
  type AccountWindows,
  bucketSamples,
  type ChartPoint,
  type ProviderWindows,
  providerWindows,
  seriesOf,
  type TokenUsageRow,
  tokenUsageRows,
  type UsageHistorySample,
  type UsageSeries,
  type UsageWire,
  type WindowRow
} from '@/components/rialto/activity/usage-derive'
import { useActivityCounts } from '@/components/rialto/activity/use-activity-counts'
import { Meter, Pill, RButton, SurfaceScope } from '@/components/rialto/primitives'
import type { SubscriptionsResponse, SubscriptionWire } from '@/components/rialto/providers/types'
import { Screen } from '@/components/rialto/Screen'
import { type AccessTokenWire, api, type InboundSurfaceWire } from '@/lib/api'
import dayjs from '@/lib/dayjs'
import { fmtAgo, fmtCount, fmtUntil } from '@/lib/rialto/format'
import { fmtCost } from '@/lib/sessions/format'

// Ranges the history endpoint accepts (it caps `days` at 30). Offered as a
// real control rather than an ornament: a week answers "did I spike", a
// month answers "is this the normal shape".
const RANGE_DAYS = [7, 14, 30] as const
const DEFAULT_RANGE_DAYS = 7
// One point per ~85 minutes over a week. The collector samples every five
// minutes, so a raw week is ~2000 points — more than the plot has pixels
// and more than recharts should be asked to lay out.
const CHART_BUCKETS = 120

const EMPTY_SUBSCRIPTIONS: SubscriptionsResponse = { subscriptions: [] }

/**
 * Series colours, validated rather than chosen by eye.
 *
 *   light  #2563eb / #d97706 / #7c3aed  on #ffffff
 *   dark   #3b82f6 / #d97706 / #8b5cf6  on #0a0a0a
 *
 * Every check passes in both modes (worst adjacent CVD ΔE 32.3 light,
 * 30.2 dark). They are Tailwind classes rather than hex so the dark step
 * is a deliberate second choice, not an automatic flip of the light one.
 *
 * Assigned in fixed order and never cycled: a fourth account's window
 * takes slot 4, and a filter that removes a series must not repaint the
 * ones that remain. Past the list, `seriesClass` returns the muted stroke
 * — an unnamed extra line is better than two series sharing a colour.
 */
const SERIES_STROKE = [
  'text-blue-600 dark:text-blue-500',
  'text-amber-600 dark:text-amber-600',
  'text-violet-600 dark:text-violet-500',
  'text-teal-600 dark:text-teal-500'
] as const
const SERIES_DOT = [
  'bg-blue-600 dark:bg-blue-500',
  'bg-amber-600',
  'bg-violet-600 dark:bg-violet-500',
  'bg-teal-600 dark:bg-teal-500'
] as const

// The vendor mark beside a provider's name — the same glyphs the Add
// provider rail draws. A hand-added provider has no vendor to draw.
const KIND_ICON: Record<ProviderWindows['kind'], string> = {
  claude: 'ri-sparkling-line',
  codex: 'ri-terminal-line',
  other: 'ri-plug-line'
}

/**
 * One tick per local midnight inside the plotted range.
 *
 * Recharts defaults to a tick per data point, which on 120 buckets prints
 * the same weekday twenty times in a row. Days are the unit the operator
 * reads a week in, so the axis is built from them rather than from the
 * sampling rate.
 */
const dayTicks = (points: readonly ChartPoint[]): number[] => {
  const first = points.at(0)
  const last = points.at(-1)
  if (first === undefined || last === undefined) return []
  const start = dayjs(first.t).startOf('day')
  const days = dayjs(last.t).diff(start, 'day') + 1
  return Array.from({ length: Math.max(0, days) }, (_, i) => start.add(i, 'day').valueOf()).filter(
    (tick) => tick >= first.t && tick <= last.t
  )
}

const seriesClass = (index: number): string =>
  index < SERIES_STROKE.length ? SERIES_STROKE[index] : 'text-muted-foreground'
const dotClass = (index: number): string => (index < SERIES_DOT.length ? SERIES_DOT[index] : 'bg-muted-foreground')

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

// One line per window rather than a stacked block: six windows across two
// accounts is the common shape, and three lines each pushed the two
// panels below it off the first screen.
function WindowLine({ row, now }: { row: WindowRow; now: number }) {
  const { t } = useTranslation()
  return (
    <div className='flex items-center gap-3 border-t border-border/60 px-6 py-2.5 transition-colors hover:bg-muted/50'>
      <span className='w-24 shrink-0 truncate text-xs'>{row.label}</span>
      <span className='w-12 shrink-0 font-mono text-[12px] text-muted-foreground'>
        {row.scope === null ? '' : row.scope}
      </span>
      <div className='min-w-0 flex-1'>
        <Meter pct={row.pct} />
      </div>
      <span className='w-10 shrink-0 text-right font-mono text-xs tabular-nums'>{`${Math.round(row.pct)}%`}</span>
      {/* A duration is a number: mono and tabular so the column lines
          up. "4h 06m" and "4d 01h" are different widths otherwise. */}
      <span className='w-20 shrink-0 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
        {fmtUntil(row.resetsAt, now) === null ? t('overview.resetsDue') : fmtUntil(row.resetsAt, now)}
      </span>
    </div>
  )
}

/**
 * An account's name, its plan, and its windows.
 *
 * The plan pill carries the multiplier because the multiplier is the plan:
 * "Max" and "Pro" are each two plans, and a 20x at 60% has four times the
 * headroom of a 5x at 60%, so a pill that cannot tell them apart makes
 * every meter under it unreadable.
 */
function AccountBlock({ account, now }: { account: AccountWindows; now: number }) {
  const { t } = useTranslation()
  return (
    <div className='min-w-0'>
      <div className='flex items-baseline gap-2 px-6 pb-1'>
        <span className='truncate text-xs font-medium'>{account.account}</span>
        {account.plan === null ? null : <Pill tone='info'>{account.plan}</Pill>}
        <span className='ml-auto text-[12px] text-muted-foreground/70'>{t('activity.usage.resetsIn')}</span>
      </div>
      {account.windows.map((row) => (
        <WindowLine key={`${row.label}-${row.scope}`} row={row} now={now} />
      ))}
    </div>
  )
}

/**
 * One provider's accounts, under its name.
 *
 * Grouped rather than flowed through one grid: flattened, a Claude account
 * and a Codex account shared a row with nothing on either saying which
 * vendor it was, and "5-hour 88%" reads the same under both. The row name
 * sits beside the label only when it says something the label does not —
 * nothing stops two subscription providers on one vendor, and "Claude
 * Code" alone would not tell them apart.
 */
function ProviderGroup({ group, now }: { group: ProviderWindows; now: number }) {
  const { t } = useTranslation()
  return (
    <div className='border-t border-border/60 pt-3 first:border-t-0 first:pt-0'>
      <div className='flex items-center gap-2 px-6 pb-2'>
        <i className={`${KIND_ICON[group.kind]} text-sm leading-none text-muted-foreground`} />
        <span className='text-[12px] font-semibold uppercase tracking-wider text-muted-foreground'>{group.label}</span>
        {group.name === null ? null : <span className='font-mono text-[12px] text-muted-foreground'>{group.name}</span>}
        <span className='text-[12px] text-muted-foreground/70'>
          {t('activity.usage.accountCount', { count: group.accounts.length })}
        </span>
      </div>
      {/* Two accounts per row once there is room, one below xl. Given the
          whole width each meter became 800px of track carrying one figure,
          with "resets in" a screen away from the percentage it qualifies.
          An odd account leaves its column empty rather than stretching to
          fill the row — and never lends it to the next provider. */}
      <div className='grid grid-cols-1 gap-x-px pb-3 xl:grid-cols-2'>
        {group.accounts.map((account) => (
          <AccountBlock key={account.subAccountId} account={account} now={now} />
        ))}
      </div>
    </div>
  )
}

function ChartTooltip({
  active,
  payload,
  label,
  series
}: {
  active?: boolean
  payload?: { dataKey?: string | number; value?: number | string }[]
  label?: number | string
  series: readonly UsageSeries[]
}) {
  const { t } = useTranslation()
  if (active !== true || payload === undefined || payload.length === 0) return null
  return (
    <div className='w-44 rounded-md border border-border bg-background px-3 py-2 shadow-sm'>
      <div className='text-[12px] text-muted-foreground'>
        {typeof label === 'number' ? dayjs(label).format('ddd HH:mm') : ''}
      </div>
      {series.map((s, index) => {
        const entry = payload.find((p) => p.dataKey === s.metric)
        if (entry === undefined || typeof entry.value !== 'number') return null
        return (
          <div key={s.metric} className='mt-1 flex items-center gap-2'>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(index)}`} />
            <span className='text-[12px]'>{s.label}</span>
            <span className='ml-auto font-mono text-[12px] tabular-nums'>{`${Math.round(entry.value)}%`}</span>
          </div>
        )
      })}
      {payload.length === 0 ? (
        <div className='mt-1 text-[12px] text-muted-foreground'>{t('common.loading')}</div>
      ) : null}
    </div>
  )
}

function UtilizationChart({ points, series }: { points: ChartPoint[]; series: readonly UsageSeries[] }) {
  const ticks = useMemo(() => dayTicks(points), [points])
  return (
    <>
      {/* Identity never rests on colour alone: the legend names every
          series, and four or fewer are the case this screen has. No note
          on how the samples were taken beside it — the sampling rate is
          the collector's business, not the reader's. */}
      <div className='flex items-center gap-4 px-6 pb-3'>
        {series.map((s, index) => (
          <span key={s.metric} className='flex items-center gap-1.5 text-[12px] text-muted-foreground'>
            <span className={`h-1.5 w-4 rounded-full ${dotClass(index)}`} />
            {s.label}
          </span>
        ))}
      </div>
      <div className='px-6 pb-5' style={{ height: 200 }}>
        <ResponsiveContainer width='100%' height='100%'>
          <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} className='stroke-border' strokeWidth={1} />
            {/* 12px, the floor everything else on these screens uses.
                The axes were at 10 and were the only text under it. */}
            <XAxis
              dataKey='t'
              type='number'
              scale='time'
              domain={['dataMin', 'dataMax']}
              ticks={ticks}
              tickFormatter={(value: number) => dayjs(value).format('ddd')}
              tickLine={false}
              axisLine={false}
              className='fill-muted-foreground'
              tick={{ fontSize: 12 }}
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tickFormatter={(value: number) => `${value}%`}
              tickLine={false}
              axisLine={false}
              className='fill-muted-foreground'
              tick={{ fontSize: 12 }}
              width={40}
            />
            <Tooltip content={<ChartTooltip series={series} />} cursor={{ className: 'stroke-border' }} />
            {series.map((s, index) => (
              <Line
                key={s.metric}
                type='monotone'
                dataKey={s.metric}
                stroke='currentColor'
                className={seriesClass(index)}
                strokeWidth={2}
                dot={false}
                // A gap is the honest rendering of a collector outage;
                // joining across it invents a line through unmeasured hours.
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  )
}

function TokenRow({
  row,
  surfaces,
  now
}: {
  row: TokenUsageRow
  surfaces: readonly InboundSurfaceWire[]
  now: number
}) {
  const { t } = useTranslation()
  const paths = row.surfaces.flatMap((id) => {
    const found = surfaces.find((s) => s.id === id)
    return found === undefined ? [] : [found.path]
  })
  return (
    <tr className='border-t border-border/60 transition-colors hover:bg-muted/50'>
      <td className='py-2.5 pl-6 pr-3'>
        <div className='truncate text-xs font-medium'>{row.name}</div>
        <div className='font-mono text-[12px] text-muted-foreground'>{row.prefix}</div>
      </td>
      <td className='px-3'>
        <SurfaceScope paths={paths} allLabel={t('settings.access.scopeAll')} />
      </td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtCount(row.requestCount)}</td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtCost(row.costUsd)}</td>
      <td className='px-3'>
        <div className='flex items-center gap-2'>
          <Meter pct={row.sharePct === null ? 0 : row.sharePct} tone='mute' />
          <span className='w-8 shrink-0 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
            {row.sharePct === null ? '–' : `${row.sharePct}%`}
          </span>
        </div>
      </td>
      <td className='py-2.5 pl-3 pr-6 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
        {row.lastUsedAt === null ? t('settings.access.never') : fmtAgo(row.lastUsedAt, now)}
      </td>
    </tr>
  )
}

/** All three panels' fetches. Kept out of the screen so it stays a layout. */
function useUsageData(days: number) {
  const [usage, setUsage] = useState<UsageWire | null>(null)
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
      fetchSubscriptions().catch(() => EMPTY_SUBSCRIPTIONS)
    ])
      .then(([usageRes, historyRes, tokenRes, surfaceRes, subscriptionRes]) => {
        setUsage(usageRes)
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

  return { usage, subscriptions, samples, tokens, surfaces, error, loading, reload: load }
}

export function ActivityUsage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const _counts = useActivityCounts()
  const [days, setDays] = useState<number>(DEFAULT_RANGE_DAYS)
  const { usage, subscriptions, samples, tokens, surfaces, error, loading, reload } = useUsageData(days)
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
            <ProviderGroup key={group.key} group={group} now={now} />
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
