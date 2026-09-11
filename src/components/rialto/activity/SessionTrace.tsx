/**
 * Activity › Session › Routing trace — every upstream call the session
 * made, newest first, a page at a time.
 *
 * The trace is the part the old build could not answer: "why did this turn
 * go to that model" was written to the request log but only readable by
 * grepping. Requested → sent, per call.
 */
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { type ActivityRequestLog, fetchSessionRequestLogs } from '@/components/rialto/activity/data'
import { LANE_KEYS, lane } from '@/components/rialto/activity/requests-rows'
import { DASH, ScreenMessage, StatusPill } from '@/components/rialto/activity/shared'
import { useSessionPage } from '@/components/rialto/activity/use-session-page'
import { Pager } from '@/components/rialto/Pager'
import { Pill } from '@/components/rialto/primitives'
import dayjs from '@/lib/dayjs'
import { fmtCost } from '@/lib/sessions/format'

// Same page size as Sessions and Requests, which page the same archive.
const PAGE_SIZE = 25

function CallRow({ call }: { call: ActivityRequestLog }) {
  const { t } = useTranslation()
  const requested = call.requestedModel === null ? t('activity.common.untracked') : call.requestedModel
  return (
    <tr className='border-t border-border/60 transition-colors hover:bg-muted/50'>
      <td className='py-2.5 pl-6 pr-3 font-mono text-[12px] tabular-nums text-muted-foreground'>
        {dayjs(call.createdAt).format('HH:mm:ss')}
      </td>
      <td className='px-3'>
        <StatusPill status={call.status} />
      </td>
      <td className='truncate px-3 font-mono text-[12px] text-muted-foreground' title={requested}>
        {requested}
      </td>
      <td className='truncate px-3 font-mono text-[12px]' title={`${call.provider},${call.model}`}>
        {`${call.provider},${call.model}`}
      </td>
      <td className='px-3'>
        <div className='flex gap-1.5'>
          <Pill tone='mute'>{call.scenario === null ? t('activity.common.untracked') : call.scenario}</Pill>
          <Pill tone='mute'>{t(LANE_KEYS[lane(call.isSubagent)])}</Pill>
        </div>
      </td>
      <td className='px-3 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
        {call.totalInputTokens.toLocaleString()}
      </td>
      <td className='px-3 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
        {call.outputTokens.toLocaleString()}
      </td>
      <td className='px-3 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
        {call.durationMs === 0 ? DASH : call.durationMs.toLocaleString()}
      </td>
      <td className='py-2.5 pl-3 pr-6 text-right font-mono text-[12px] tabular-nums'>{fmtCost(call.totalCostUsd)}</td>
    </tr>
  )
}

/**
 * Chronological and unsorted on purpose: the trace is a story — this
 * model was asked for, that one answered, then the next one did — and a
 * sortable column would let the reader break the only ordering that
 * carries meaning here. It runs newest first because the latest calls are
 * what a session is opened for, whether it is still running or finished;
 * oldest first put them on the last page of a long session. Within a
 * burst the story still reads bottom-up: a 429 sits just below the
 * failover that answered it.
 *
 * Column labels are borrowed from the Requests screen. They name the same
 * fields, and a second set of identical strings in three locales would
 * only be a second thing to keep in step.
 */
function TraceTable({ calls }: { calls: ActivityRequestLog[] }) {
  const { t } = useTranslation()
  if (calls.length === 0) {
    return <ScreenMessage>{t('activity.session.noCalls')}</ScreenMessage>
  }
  return (
    <table className='w-full table-fixed'>
      <colgroup>
        <col className='w-24' />
        <col className='w-20' />
        <col />
        <col />
        <col className='w-52' />
        <col className='w-20' />
        <col className='w-20' />
        <col className='w-20' />
        <col className='w-24' />
      </colgroup>
      <thead>
        <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2 [&>th]:font-medium'>
          <th className='pl-6 pr-3 text-left'>{t('activity.requests.colTime')}</th>
          <th className='px-3 text-left'>{t('activity.requests.colStatus')}</th>
          <th className='px-3 text-left'>{t('activity.requests.colRequested')}</th>
          <th className='px-3 text-left'>{t('activity.requests.colSent')}</th>
          <th className='px-3 text-left'>{t('activity.requests.colRule')}</th>
          <th className='px-3 text-right'>{t('activity.requests.colInput')}</th>
          <th className='px-3 text-right'>{t('activity.requests.colOutput')}</th>
          <th className='px-3 text-right'>{t('activity.requests.colMs')}</th>
          <th className='pl-3 pr-6 text-right'>{t('activity.requests.colCost')}</th>
        </tr>
      </thead>
      <tbody>
        {calls.map((call) => (
          <CallRow key={call.id} call={call} />
        ))}
      </tbody>
    </table>
  )
}

/** Mount with `key={sessionId}` so another session opens on its newest page. */
export function SessionTrace({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const fetchPage = useCallback((offset: number) => fetchSessionRequestLogs(sessionId, PAGE_SIZE, offset), [sessionId])
  const { pageIndex, setPageIndex, page, error } = useSessionPage(fetchPage, PAGE_SIZE)

  if (error !== null) return <ScreenMessage tone='bad'>{error}</ScreenMessage>
  if (page === null) return <ScreenMessage>{t('common.loading')}</ScreenMessage>
  return (
    <>
      <TraceTable calls={page.items} />
      <Pager
        page={pageIndex}
        pageSize={PAGE_SIZE}
        loaded={page.items.length}
        total={page.total}
        onPage={setPageIndex}
      />
    </>
  )
}
