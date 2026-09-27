/**
 * Overview — the one-page answer to "is Rialto doing what I set it up to
 * do right now".
 *
 * The headline is the four inbound surfaces, because that is Rialto's
 * identity (four wire formats in, many vendors out) and because the old
 * build gave the operator no way to see that only one of them was
 * actually routed.
 */

import { cn } from 'cn'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Pill, RButton, Section } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api, type OverviewResponse, type OverviewSpendRow } from '@/lib/api'
import { fmtCost } from '@/lib/sessions/format'
import { FailoverEntry, SessionTable } from './OverviewActivity'
import { QuotaAccount } from './OverviewQuota'
import { SurfaceTable, SurfaceTiles } from './OverviewSurfaces'

// Spend is going up or down, and neither direction is an alarm on its
// own — a rise past a tenth is the one worth colouring.
const deltaTone = (ratio: number): 'warn' | 'ok' | 'mute' => {
  if (ratio > 0.1) return 'warn'
  if (ratio < 0) return 'ok'
  return 'mute'
}

const fmtDelta = (ratio: number): string => `${ratio > 0 ? '+' : ''}${Math.round(ratio * 100)}%`

const SPEND_LABEL_KEYS: Record<OverviewSpendRow['label'], string> = {
  today: 'overview.spendToday',
  week: 'overview.spendWeek',
  month: 'overview.spendMonth',
  savedBySubscription: 'overview.spendSaved'
}

/**
 * The window the whole page describes.
 *
 * The mock draws this as a static "Last 24h" button and the first build
 * shipped it inert, so the one control in the header did nothing while
 * `/api/overview` had accepted `windowHours` up to 720 all along.
 */
const RANGES: readonly { hours: number; labelKey: string }[] = [
  { hours: 1, labelKey: 'activity.requests.range1h' },
  { hours: 24, labelKey: 'activity.requests.range24h' },
  { hours: 24 * 7, labelKey: 'activity.requests.range7d' },
  { hours: 24 * 30, labelKey: 'activity.sessions.range30d' }
]

export function Overview() {
  const { t } = useTranslation()
  const [data, setData] = useState<OverviewResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Captured once per load so every relative label on the page is
  // measured from the same instant the data describes.
  const [now, setNow] = useState(Date.now())
  const [windowHours, setWindowHours] = useState(24)
  const [rangeOpen, setRangeOpen] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    api
      .getOverview({ windowHours })
      .then((res) => {
        setData(res)
        setNow(Date.parse(res.generatedAt))
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [windowHours])

  useEffect(load, [load])

  const range = RANGES.find((r) => r.hours === windowHours)
  const rangeLabelKey = range === undefined ? 'activity.requests.range24h' : range.labelKey

  const subtitle =
    data === null
      ? undefined
      : t('overview.subtitle', {
          surfaces: data.surfaces.length,
          providers: data.providerCount,
          models: data.enabledModelCount
        })

  return (
    <Screen
      subtitle={subtitle}
      actions={
        <>
          <Popover open={rangeOpen} onOpenChange={setRangeOpen}>
            <PopoverTrigger asChild>
              <RButton variant='outline' icon='ri-time-line'>
                {t(rangeLabelKey)}
              </RButton>
            </PopoverTrigger>
            <PopoverContent align='end' className='w-40 p-1'>
              {RANGES.map((r) => (
                <button
                  key={r.hours}
                  type='button'
                  onClick={() => {
                    setWindowHours(r.hours)
                    setRangeOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60',
                    r.hours === windowHours ? 'font-medium' : 'text-muted-foreground'
                  )}
                >
                  {t(r.labelKey)}
                </button>
              ))}
            </PopoverContent>
          </Popover>
          <RButton variant='ghost' icon='ri-refresh-line' onClick={load} disabled={loading}>
            {t('settings.advanced.refresh')}
          </RButton>
        </>
      }
    >
      {error !== null ? (
        <div className='px-6 py-6 text-xs text-destructive'>{error}</div>
      ) : data === null ? (
        <div className='px-6 py-6 text-xs text-muted-foreground'>{t('common.loading')}</div>
      ) : (
        <>
          <Section title={t('overview.spend')}>
            <div className='grid grid-cols-4 gap-px px-6 pb-6'>
              {data.spend.map((s) => (
                <Link
                  key={s.label}
                  to='/activity/usage'
                  className='border-l-2 border-l-border px-4 py-3 transition-colors hover:bg-muted/50 hover:border-l-foreground/30'
                >
                  <div className='text-[12px] uppercase tracking-wider text-muted-foreground'>
                    {t(SPEND_LABEL_KEYS[s.label])}
                  </div>
                  <div className='mt-1 flex items-baseline gap-2'>
                    <span className='font-mono text-xl tabular-nums'>{fmtCost(s.usd)}</span>
                    {s.deltaRatio === null ? null : (
                      // A bare "+126%" reads as a share of something. It is
                      // the move against the previous period of the same
                      // length, which only the tooltip can say in the space.
                      <Pill tone={deltaTone(s.deltaRatio)} title={t('overview.spendDeltaHint')}>
                        {fmtDelta(s.deltaRatio)}
                      </Pill>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </Section>

          <Section
            title={t('overview.inboundSurfaces')}
            meta={
              // "last 168h" is arithmetic, not a period anyone thinks in.
              data.windowHours >= 24 && data.windowHours % 24 === 0
                ? t('overview.lastDays', { days: data.windowHours / 24 })
                : t('overview.lastHours', { hours: data.windowHours })
            }
          >
            {/* Which of the two is drawn is decided by the section's own
                width, not the viewport's: the sidebar folds with ⌘B at any
                width, so a viewport breakpoint would keep the table across
                width the section actually has. 72rem is where a tile still
                fits "/v1/chat/completions" beside "passthrough". */}
            <div className='@container'>
              <SurfaceTable data={data} />
              <SurfaceTiles data={data} />
            </div>
          </Section>

          {/* Stacked, not side by side. The two-column split was fine when
              a quota row was one line per account; an account now lists
              every window it has, so the left column wrapped while the
              right sat half empty. */}
          <Section title={t('overview.subscriptionQuota')} meta={t('overview.quotaMeta')}>
            {data.quota.length === 0 ? (
              <div className='px-6 pb-6 text-xs text-muted-foreground'>{t('overview.noQuota')}</div>
            ) : (
              // Inside the section the accounts do flow into columns, as
              // many as fit at 36rem each, up to three: an account block is
              // fixed columns (label, capped meter, percent, reset) 36rem
              // wide with its padding, so one column on a wide pane left two
              // thirds of it empty. Measured on the section, as the surface
              // tiles are.
              <div className='@container'>
                <div className='grid grid-cols-1 gap-x-px @min-[72rem]:grid-cols-2 @min-[108rem]:grid-cols-3'>
                  {data.quota.map((q) => (
                    <QuotaAccount key={q.subAccountId} row={q} now={now} />
                  ))}
                </div>
              </div>
            )}
          </Section>

          <Section title={t('overview.failoverActivity')} meta={t('overview.failoverMeta')}>
            {data.failover.length === 0 ? (
              <div className='px-6 pb-6 text-xs text-muted-foreground'>{t('overview.noFailover')}</div>
            ) : (
              data.failover.map((f) => <FailoverEntry key={`${f.kind}-${f.at}-${f.account}`} row={f} now={now} />)
            )}
          </Section>

          <Section title={t('overview.recentSessions')}>
            <SessionTable data={data} now={now} />
          </Section>
          <div className='h-10' />
        </>
      )}
    </Screen>
  )
}
