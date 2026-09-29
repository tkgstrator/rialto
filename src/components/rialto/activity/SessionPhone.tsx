/**
 * Activity › Session at phone width: the four figures worth a glance and
 * the routing trace as a list.
 *
 * The token split (input, output, cache read) stays on the desktop strip;
 * the cache hit rate already says what those three add up to. A traced
 * call keeps the story the trace exists to tell — what was asked for and
 * what answered — with its status, time and cost, and drops the rule
 * pills and token columns that pushed the table to 720px.
 */
import { useTranslation } from 'react-i18next'
import type { ActivityRequestLog } from '@/components/rialto/activity/data'
import { StatusPill } from '@/components/rialto/activity/shared'
import { PhoneRow, PhoneStats } from '@/components/rialto/primitives'
import type { SessionSummary } from '@/lib/api'
import dayjs from '@/lib/dayjs'
import { fmtAgo, fmtRate } from '@/lib/rialto/format'
import { fmtCost } from '@/lib/sessions/format'

export function SessionStatsPhone({ summary }: { summary: SessionSummary }) {
  const { t } = useTranslation()
  const totalInput = summary.totalInputTokens
  return (
    <div className='border-b border-border pt-4'>
      <PhoneStats
        items={[
          { label: t('activity.session.cost'), value: fmtCost(summary.totalCostUsd) },
          { label: t('activity.session.upstreamCalls'), value: summary.requestCount },
          {
            label: t('activity.session.cacheHit'),
            value: fmtRate(totalInput === 0 ? null : summary.totalCacheReadTokens / totalInput)
          },
          {
            label: t('activity.session.duration'),
            value: fmtAgo(summary.firstAt, Date.parse(summary.lastAt))
          }
        ]}
      />
    </div>
  )
}

/**
 * Newest first and unsorted, as the desktop trace is. The requested model
 * is on the second line only when it differs from the one that served
 * the call: that difference is the routing decision, and repeating the
 * same name twice on every row would bury the rows where it happened.
 */
export function TraceListPhone({ calls }: { calls: ActivityRequestLog[] }) {
  const { t } = useTranslation()
  return (
    <div className='[&>*:first-child]:border-t-0'>
      {calls.map((call) => {
        const requested = call.requestedModel === null ? t('activity.common.untracked') : call.requestedModel
        return (
          <PhoneRow
            key={call.id}
            primary={
              <span className='font-mono' title={`${call.provider},${call.model}`}>
                {call.model}
              </span>
            }
            trailing={fmtCost(call.totalCostUsd)}
            secondary={
              <>
                <StatusPill status={call.status} />
                <span className='shrink-0 font-mono tabular-nums'>{dayjs(call.createdAt).format('HH:mm:ss')}</span>
                {requested === call.model ? null : <span className='min-w-0 truncate font-mono'>← {requested}</span>}
                <span className='ml-auto shrink-0'>
                  {call.scenario === null ? t('activity.common.untracked') : call.scenario}
                </span>
              </>
            }
          />
        )
      })}
    </div>
  )
}
