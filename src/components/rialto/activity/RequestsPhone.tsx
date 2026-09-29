/**
 * Activity › Requests at phone width.
 *
 * Four tiles rather than five — 2xx is what is left of the total once the
 * two failure counts are known, and an odd tile out left a hole in the
 * two-column grid. A call is the model that served it and what it cost,
 * with its status, time, caller and latency beneath. The requested model,
 * the rule and the token split stay on the desktop table: they explain a
 * routing decision, which is not something settled from a phone.
 */
import { useTranslation } from 'react-i18next'
import type { RequestLogStats } from '@/components/rialto/activity/data'
import { TimeCell } from '@/components/rialto/activity/request-columns'
import type { Row } from '@/components/rialto/activity/requests-rows'
import { DASH, StatusPill } from '@/components/rialto/activity/shared'
import { PhoneRow, PhoneStats } from '@/components/rialto/primitives'
import { fmtLatency, fmtRate } from '@/lib/rialto/format'
import { fmtCost } from '@/lib/sessions/format'

export function RequestsPhoneStats({ stats, rangeLabel }: { stats: RequestLogStats; rangeLabel: string }) {
  const { t } = useTranslation()
  const share = (n: number): string => (stats.total === 0 ? '–' : fmtRate(n / stats.total))
  return (
    <div className='border-b border-border pt-4'>
      <PhoneStats
        items={[
          {
            label: t('activity.requests.statRequests'),
            value: stats.total.toLocaleString(),
            note: rangeLabel.toLowerCase()
          },
          { label: '4xx / 5xx', value: stats.failed.toLocaleString(), note: share(stats.failed) },
          { label: '429', value: stats.rateLimited.toLocaleString(), note: t('activity.requests.statRateLimitedSub') },
          { label: 'p50', value: fmtLatency(stats.p50), note: `p95 ${fmtLatency(stats.p95)}` }
        ]}
      />
    </div>
  )
}

/** Each call opens its session, as a row of the desktop table does. */
export function RequestsPhoneList({ rows }: { rows: Row[] }) {
  const { t } = useTranslation()
  return (
    <div className='[&>*:first-child]:border-t-0'>
      {rows.map((row) => (
        <PhoneRow
          key={row.log.id}
          href={`/activity/sessions/${encodeURIComponent(row.log.sessionId)}`}
          primary={
            <span className='font-mono' title={`${row.log.provider},${row.log.model}`}>
              {row.log.model}
            </span>
          }
          trailing={fmtCost(row.log.totalCostUsd)}
          secondary={
            <>
              <StatusPill status={row.log.status} />
              <span className='shrink-0 font-mono tabular-nums'>
                <TimeCell iso={row.log.createdAt} />
              </span>
              <span className='min-w-0 truncate'>
                {row.client === null ? t('activity.common.untracked') : row.client}
              </span>
              <span className='ml-auto shrink-0 font-mono tabular-nums'>
                {row.log.durationMs === 0 ? DASH : fmtLatency(row.log.durationMs)}
              </span>
            </>
          }
        />
      ))}
    </div>
  )
}
