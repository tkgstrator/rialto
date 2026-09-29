/**
 * Overview at phone width.
 *
 * The same five sections in the same order, each cut to what answers
 * "is it working" at a glance: spend as a two-by-two grid, a surface as
 * its path, mode and request count, a quota window as its meter, percent
 * and reset, a session as its cost and age. p50, error rate, turns, token
 * counts and the API-equivalent usage lines stay on the desktop screen.
 *
 * Failover rows are the desktop component unchanged: they were already a
 * two-line block, which is the phone shape.
 */

import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { surfaceLabel } from '@/components/rialto/activity/use-surfaces'
import { Meter, PhoneRow, PhoneStats, Pill, Section, SurfacePill } from '@/components/rialto/primitives'
import type { OverviewQuotaRow, OverviewResponse } from '@/lib/api'
import { fmtAgo, fmtCount, fmtUntil, shortId } from '@/lib/rialto/format'
import { fmtCost } from '@/lib/sessions/format'
import { FailoverEntry } from './OverviewActivity'
import { RoutingModePill } from './OverviewSurfaces'
import { deltaTone, fmtDelta, SPEND_LABEL_KEYS, windowMeta } from './overview-shared'

export function OverviewPhone({ data, now }: { data: OverviewResponse; now: number }) {
  const { t } = useTranslation()
  return (
    <>
      <Section title={t('overview.spend')}>
        <PhoneStats
          items={data.spend.map((s) => ({
            label: t(SPEND_LABEL_KEYS[s.label]),
            value: fmtCost(s.usd),
            note:
              s.deltaRatio === null ? undefined : <Pill tone={deltaTone(s.deltaRatio)}>{fmtDelta(s.deltaRatio)}</Pill>,
            href: '/activity/usage'
          }))}
        />
      </Section>

      <Section title={t('overview.inboundSurfaces')} meta={windowMeta(data.windowHours, t)}>
        <div className='pb-2'>
          {data.surfaces.map((s) => (
            <PhoneRow
              key={s.id}
              href={`/routing?surface=${s.id}`}
              primary={<span className='font-mono'>{s.path}</span>}
              trailing={fmtCount(s.requests)}
              secondary={
                <>
                  <RoutingModePill mode={s.routingMode} />
                  <span className='truncate'>{s.client}</span>
                </>
              }
            />
          ))}
        </div>
      </Section>

      <Section title={t('overview.subscriptionQuota')}>
        {data.quota.length === 0 ? (
          <div className='px-4 pb-6 text-xs text-muted-foreground'>{t('overview.noQuota')}</div>
        ) : (
          <div className='pb-2'>
            {data.quota.map((q) => (
              <PhoneQuotaAccount key={q.subAccountId} row={q} now={now} />
            ))}
          </div>
        )}
      </Section>

      <Section title={t('overview.failoverActivity')}>
        {data.failover.length === 0 ? (
          <div className='px-4 pb-6 text-xs text-muted-foreground'>{t('overview.noFailover')}</div>
        ) : (
          data.failover.map((f) => <FailoverEntry key={`${f.kind}-${f.at}-${f.account}`} row={f} now={now} />)
        )}
      </Section>

      <Section title={t('overview.recentSessions')}>
        {data.recentSessions.length === 0 ? (
          <div className='px-4 pb-6 text-xs text-muted-foreground'>{t('overview.noSessions')}</div>
        ) : (
          data.recentSessions.map((s) => {
            const label = surfaceLabel(data.surfaces, s.surface)
            return (
              <PhoneRow
                key={s.sessionId}
                href={`/activity/sessions/${s.sessionId}`}
                primary={<span className='font-mono'>{shortId(s.sessionId)}</span>}
                trailing={fmtCost(s.costUsd)}
                secondary={
                  <>
                    {label === undefined ? null : <SurfacePill path={label.path} />}
                    <span className='min-w-0 truncate font-mono'>{s.model}</span>
                    <span className='ml-auto shrink-0 font-mono tabular-nums'>{fmtAgo(s.lastAt, now)}</span>
                  </>
                }
              />
            )
          })
        )}
      </Section>
      <div className='h-6' />
    </>
  )
}

/**
 * One account's windows, the meter stretched to whatever the row has
 * left. The desktop row caps it at 16rem so neighbouring percentages stay
 * readable across a wide pane; on a phone the pane is the cap.
 */
function PhoneQuotaAccount({ row, now }: { row: OverviewQuotaRow; now: number }) {
  const { t } = useTranslation()
  return (
    <Link to='/activity/usage' className='block border-t border-border/60 px-4 py-3 active:bg-muted/50'>
      <div className='truncate text-xs font-medium'>{row.account}</div>
      <div className='mt-2 space-y-2'>
        {row.windows.map((w) => {
          const until = fmtUntil(w.resetAt, now)
          return (
            <div key={`${w.window}-${w.scope}`} className='flex items-center gap-3'>
              <span className='w-20 shrink-0 truncate font-mono text-[12px] text-muted-foreground'>
                {w.scope === null ? w.window : `${w.window} · ${w.scope}`}
              </span>
              <div className='min-w-0 flex-1'>
                <Meter pct={w.pct} />
              </div>
              <span className='w-9 shrink-0 text-right font-mono text-[12px] tabular-nums'>{w.pct}%</span>
              <span className='w-14 shrink-0 truncate text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
                {until === null ? t('overview.resetsDueShort') : until}
              </span>
            </div>
          )
        })}
      </div>
    </Link>
  )
}
