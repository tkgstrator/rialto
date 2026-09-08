/**
 * Overview — the one-page answer to "is Rialto doing what I set it up to
 * do right now".
 *
 * The headline is the four inbound surfaces, because that is Rialto's
 * identity (four wire formats in, many vendors out) and because the old
 * build gave the operator no way to see that only one of them was
 * actually routed.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Meter, Mono, Pill, RButton, Section, SurfacePill } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { api, type OverviewResponse, type OverviewSpendRow } from '@/lib/api'
import { fmtAgo, fmtCount, fmtLatency, fmtRate, fmtUntil, shortId } from '@/lib/rialto/format'
import { fmtCost, fmtTokens } from '@/lib/sessions/format'

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

function SurfaceTable({ data }: { data: OverviewResponse }) {
  const { t } = useTranslation()
  return (
    <table className='w-full table-fixed'>
      <colgroup>
        <col />
        <col className='w-32' />
        <col className='w-28' />
        <col className='w-20' />
        <col className='w-24' />
      </colgroup>
      <thead>
        <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:pb-2'>
          <th className='pl-6 pr-3 text-left font-medium'>{t('overview.colSurface')}</th>
          <th className='px-3 text-left font-medium'>{t('overview.colRouting')}</th>
          <th className='px-3 text-right font-medium'>{t('overview.colRequests')}</th>
          <th className='px-3 text-right font-medium'>p50</th>
          <th className='pl-3 pr-6 text-right font-medium'>{t('overview.colErrors')}</th>
        </tr>
      </thead>
      <tbody>
        {data.surfaces.map((s) => (
          <tr key={s.id} className='border-t border-border/60 transition-colors hover:bg-muted/50'>
            <td className='py-2.5 pl-6 pr-3'>
              <div className='font-mono text-xs'>{s.path}</div>
              <div className='text-[12px] text-muted-foreground'>{s.client}</div>
            </td>
            <td className='px-3'>
              {s.routingMode === 'routed' ? (
                <Pill tone='ok'>{t('routing.common.modeRouted')}</Pill>
              ) : (
                <Pill tone='mute'>{t('routing.common.modePassthrough')}</Pill>
              )}
            </td>
            <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtCount(s.requests)}</td>
            <td className='px-3 text-right font-mono text-xs tabular-nums text-muted-foreground'>
              {fmtLatency(s.p50Ms)}
            </td>
            <td className='py-2.5 pl-3 pr-6 text-right font-mono text-xs tabular-nums text-muted-foreground'>
              {fmtRate(s.errorRate)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * The eight most recent sessions — deliberately not sortable. The server
 * already truncated to the newest eight, so a "most expensive" header
 * here would rank that slice while reading as an answer about every
 * session. That question belongs to Activity → Sessions, which holds the
 * whole list. The surface table above is likewise fixed: one row per
 * registered inbound surface, in registry order.
 */
function SessionTable({ data, now }: { data: OverviewResponse; now: number }) {
  const { t } = useTranslation()
  if (data.recentSessions.length === 0) {
    return <div className='px-6 pb-6 text-xs text-muted-foreground'>{t('overview.noSessions')}</div>
  }
  return (
    <table className='w-full table-fixed'>
      <colgroup>
        <col className='w-40' />
        <col className='w-40' />
        <col />
        <col className='w-16' />
        <col className='w-20' />
        <col className='w-24' />
        <col className='w-16' />
      </colgroup>
      <thead>
        <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:pb-2'>
          <th className='pl-6 pr-3 text-left font-medium'>{t('activity.sessions.colSession')}</th>
          <th className='px-3 text-left font-medium'>{t('activity.sessions.colEndpoint')}</th>
          <th className='px-3 text-left font-medium'>{t('activity.sessions.colModel')}</th>
          <th className='px-3 text-right font-medium'>{t('activity.sessions.colTurns')}</th>
          <th className='px-3 text-right font-medium'>{t('activity.sessions.statTokens')}</th>
          <th className='px-3 text-right font-medium'>{t('activity.sessions.colCost')}</th>
          <th className='pl-3 pr-6 text-right font-medium'>{t('activity.sessions.colLast')}</th>
        </tr>
      </thead>
      <tbody>
        {data.recentSessions.map((s) => {
          const path = data.surfaces.find((x) => x.id === s.surface)?.path
          return (
            <tr key={s.sessionId} className='border-t border-border/60 transition-colors hover:bg-muted/50'>
              <td className='py-2.5 pl-6 pr-3 font-mono text-xs'>{shortId(s.sessionId)}</td>
              <td className='px-3'>
                {path === undefined ? <Mono>{t('activity.requests.laneUntracked')}</Mono> : <SurfacePill path={path} />}
              </td>
              <td className='px-3 font-mono text-xs text-muted-foreground'>{s.model}</td>
              <td className='px-3 text-right font-mono text-xs tabular-nums'>{s.turns}</td>
              <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtTokens(s.tokens)}</td>
              <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtCost(s.costUsd)}</td>
              <td className='py-2.5 pl-3 pr-6 text-right text-[12px] text-muted-foreground'>{fmtAgo(s.lastAt, now)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export function Overview() {
  const { t } = useTranslation()
  const [data, setData] = useState<OverviewResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Captured once per load so every relative label on the page is
  // measured from the same instant the data describes.
  const [now, setNow] = useState(Date.now())

  const load = useCallback(() => {
    setLoading(true)
    api
      .getOverview({ windowHours: 24 })
      .then((res) => {
        setData(res)
        setNow(Date.parse(res.generatedAt))
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(load, [load])

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
          <RButton variant='outline' icon='ri-time-line'>
            {t('activity.requests.range24h')}
          </RButton>
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
          <Section title={t('overview.inboundSurfaces')} meta={t('overview.lastHours', { hours: data.windowHours })}>
            <SurfaceTable data={data} />
          </Section>

          <Section title={t('overview.spend')}>
            <div className='grid grid-cols-4 gap-px px-6 pb-6'>
              {data.spend.map((s) => (
                <div
                  key={s.label}
                  className='border-l-2 border-l-border px-4 py-3 transition-colors hover:bg-muted/50 hover:border-l-foreground/30'
                >
                  <div className='text-[12px] uppercase tracking-wider text-muted-foreground'>
                    {t(SPEND_LABEL_KEYS[s.label])}
                  </div>
                  <div className='mt-1 flex items-baseline gap-2'>
                    <span className='font-mono text-xl tabular-nums'>{fmtCost(s.usd)}</span>
                    {s.deltaRatio === null ? null : (
                      <Pill tone={deltaTone(s.deltaRatio)}>{fmtDelta(s.deltaRatio)}</Pill>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Section>

          <div className='grid grid-cols-2 border-t border-border'>
            <div className='border-r border-border'>
              <Section title={t('overview.subscriptionQuota')}>
                {data.quota.length === 0 ? (
                  <div className='px-6 pb-6 text-xs text-muted-foreground'>{t('overview.noQuota')}</div>
                ) : (
                  data.quota.map((q) => (
                    <div
                      key={`${q.subAccountId}-${q.window}`}
                      className='border-t border-border/60 px-6 py-3 transition-colors hover:bg-muted/50'
                    >
                      <div className='flex items-baseline gap-2'>
                        <span className='text-xs font-medium'>{q.account}</span>
                        <Mono>{q.window}</Mono>
                        <span className='ml-auto font-mono text-xs tabular-nums'>{q.pct}%</span>
                      </div>
                      <div className='mt-2'>
                        <Meter pct={q.pct} />
                      </div>
                      <div className='mt-1.5 text-[12px] text-muted-foreground'>
                        {t('overview.resetsIn', { until: fmtUntil(q.resetAt, now) })}
                      </div>
                    </div>
                  ))
                )}
              </Section>
            </div>
            <div>
              <Section title={t('overview.failoverActivity')}>
                {data.failover.length === 0 ? (
                  <div className='px-6 pb-6 text-xs text-muted-foreground'>{t('overview.noFailover')}</div>
                ) : (
                  <div className='space-y-0'>
                    {data.failover.map((f) => (
                      <div
                        key={`${f.kind}-${f.at}-${f.headline}`}
                        className='border-t border-border/60 px-6 py-3 transition-colors hover:bg-muted/50'
                      >
                        <div className='flex items-baseline gap-2'>
                          <Pill tone={f.tone}>{f.label}</Pill>
                          <span className='text-xs'>{f.headline}</span>
                          <span className='ml-auto text-[12px] text-muted-foreground'>
                            {f.at === '' ? '' : t('settings.access.lastUsedAgo', { ago: fmtAgo(f.at, now) })}
                          </span>
                        </div>
                        <div className='mt-1 text-[12px] text-muted-foreground'>{f.detail}</div>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            </div>
          </div>

          <Section title={t('overview.recentSessions')}>
            <SessionTable data={data} now={now} />
          </Section>
          <div className='h-10' />
        </>
      )}
    </Screen>
  )
}
