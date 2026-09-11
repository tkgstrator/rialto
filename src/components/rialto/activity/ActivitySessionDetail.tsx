/**
 * Activity › Session — what one session cost, and where each of its calls went.
 *
 * The trace is the part the old build could not answer: "why did this turn
 * go to that model" was written to the request log but only readable by
 * grepping. Requested → sent, per call, in the order they happened.
 *
 * The archived transcript used to sit beside it in the wider column. It is
 * gone: a real Claude Code session is mostly tool traffic and injected
 * context, so the pane spent a screen's width rendering material nobody
 * came here to read, and the routing trace — the one thing this screen
 * knows that no other screen does — was squeezed into a 22rem rail that
 * could only show its last five rows. The messages are still archived and
 * still reachable at GET /api/request-logs/sessions/:id/messages; what
 * capture feeds in the UI now is the session's title.
 */
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { type ActivityRequestLog, fetchSessionRequestLogs } from '@/components/rialto/activity/data'
import { LANE_KEYS, lane as laneOf } from '@/components/rialto/activity/requests-rows'
import { DASH, ScreenMessage, StatusPill } from '@/components/rialto/activity/shared'
import { useSurfaces } from '@/components/rialto/activity/use-surfaces'
import { Meter, Pill, RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { api, type SessionSummary } from '@/lib/api'
import dayjs from '@/lib/dayjs'
import { fmtAgo, fmtRate, shortId } from '@/lib/rialto/format'
import { fmtCost } from '@/lib/sessions/format'

/**
 * One figure, with its name above it.
 *
 * The strip reads left to right, so the label sits on top rather than
 * opposite: a row of nine `label ... value` pairs turned into a column
 * of ragged gaps the moment it stopped being 22rem wide.
 */
function Stat({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <div className='min-w-0'>
      <div className='text-[12px] text-muted-foreground'>{label}</div>
      <div className='mt-0.5 font-mono text-xs tabular-nums'>{value}</div>
      {children}
    </div>
  )
}

/**
 * The session's numbers, across the top.
 *
 * These were nine rows down the right rail, above the routing trace, on a
 * screen whose subject was the transcript beside them. Read left to right
 * they cost one line, and the width goes to the trace — the part that
 * grows with the session. Inbound is not here because the subtitle
 * already says it.
 */
function StatStrip({ summary }: { summary: SessionSummary }) {
  const { t } = useTranslation()
  const totalInput = summary.totalInputTokens
  const cacheRate = totalInput === 0 ? null : summary.totalCacheReadTokens / totalInput
  const cachePct = cacheRate === null ? 0 : Math.round(cacheRate * 100)
  return (
    <div className='flex flex-wrap items-start gap-x-10 gap-y-3 border-b border-border px-6 py-3'>
      <Stat label={t('activity.session.upstreamCalls')} value={summary.requestCount} />
      <Stat label={t('activity.session.inputTokens')} value={summary.totalInputTokens.toLocaleString()} />
      <Stat label={t('activity.session.outputTokens')} value={summary.totalOutputTokens.toLocaleString()} />
      <Stat label={t('activity.session.cacheRead')} value={summary.totalCacheReadTokens.toLocaleString()} />
      <Stat label={t('activity.session.cacheHit')} value={fmtRate(cacheRate)}>
        {/* Explicit `ok`: a high cache hit is the good end of the scale, the
            inverse of the utilization meters the auto tone is built for. */}
        <div className='mt-1.5 w-24'>
          <Meter pct={cachePct} tone='ok' />
        </div>
      </Stat>
      <Stat label={t('activity.session.cost')} value={fmtCost(summary.totalCostUsd)} />
      <Stat label={t('activity.session.duration')} value={fmtAgo(summary.firstAt, Date.parse(summary.lastAt))} />
    </div>
  )
}

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
          <Pill tone='mute'>{t(LANE_KEYS[laneOf(call.isSubagent)])}</Pill>
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
 * Every upstream call the session made, oldest first.
 *
 * Chronological and unsorted on purpose: the trace is a story — this
 * model was asked for, that one answered, then the next one did — and a
 * sortable column would let the reader break the only ordering that
 * carries meaning here. Nothing is folded away either; the rail showed
 * the last five behind a "show all" because it was 22rem wide.
 *
 * Column labels are borrowed from the Requests screen. They name the same
 * fields, and a second set of identical strings in three locales would
 * only be a second thing to keep in step.
 */
function TraceTable({ calls }: { calls: ActivityRequestLog[] }) {
  const { t } = useTranslation()
  if (calls.length === 0) {
    return <div className='px-6 py-6 text-xs text-muted-foreground'>{t('activity.session.noCalls')}</div>
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

interface Loaded {
  summary: SessionSummary
  calls: ActivityRequestLog[]
}

export function ActivitySessionDetail() {
  const { t } = useTranslation()
  const { sessionId = '' } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [neighbours, setNeighbours] = useState<string[]>([])
  const surfaces = useSurfaces()

  useEffect(() => {
    setData(null)
    Promise.all([api.getSessionSummary(sessionId), fetchSessionRequestLogs(sessionId)])
      .then(([summary, logs]) => {
        // Logs arrive newest-first; the trace reads as a story forwards.
        setData({ summary, calls: [...logs.items].reverse() })
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [sessionId])

  // Previous / Next walk the same list the Activity table shows, so the
  // header arrows move through what the operator was just looking at.
  useEffect(() => {
    api
      .getRequestLogSessions({ limit: 100, sinceHours: 168 })
      .then((res) => setNeighbours(res.sessions.map((s) => s.sessionId)))
      .catch(() => {
        // Navigation affordance only.
      })
  }, [])

  const inboundPath = data === null ? null : surfaces.pathOf(data.summary.surface)

  const index = neighbours.indexOf(sessionId)
  const prev = index > 0 ? neighbours[index - 1] : null
  const next = index >= 0 && index < neighbours.length - 1 ? neighbours[index + 1] : null

  // Short everywhere it is read rather than routed on: the raw uuid is
  // still what Previous/Next and the fetch use, but the breadcrumb,
  // subtitle and title-fallback are read by a person, the same as the
  // Sessions table's own `shortId` column.
  const title = data === null ? shortId(sessionId) : preferredTitle(data.summary, shortId(sessionId))
  const subtitle =
    data === null
      ? undefined
      : t('activity.session.subtitle', {
          sessionId: shortId(sessionId),
          inbound: inboundPath === null ? t('activity.common.untracked') : inboundPath
        })

  return (
    <Screen
      // Activity / Sessions / <id> — the third level the tree cannot name.
      crumbs={[{ label: shortId(sessionId) }]}
      subtitle={subtitle}
      actions={
        <>
          <RButton
            variant='ghost'
            icon='ri-arrow-up-s-line'
            disabled={prev === null}
            onClick={() => prev !== null && navigate(`/activity/sessions/${encodeURIComponent(prev)}`)}
          >
            {t('activity.session.previous')}
          </RButton>
          <RButton
            variant='ghost'
            icon='ri-arrow-down-s-line'
            disabled={next === null}
            onClick={() => next !== null && navigate(`/activity/sessions/${encodeURIComponent(next)}`)}
          >
            {t('common.next')}
          </RButton>
        </>
      }
    >
      {error !== null ? (
        <ScreenMessage tone='bad'>{error}</ScreenMessage>
      ) : data === null ? (
        <ScreenMessage>{t('common.loading')}</ScreenMessage>
      ) : (
        <div className='min-w-0'>
          {/* No back arrow and no session id here: the breadcrumb above
              says "Activity / Sessions / <id>" and the subtitle repeats
              the id, so a third copy beside a second way back was the
              header competing with itself. What is left is the one thing
              neither of them can carry — the session's own title. */}
          <div className='flex items-center gap-2 border-b border-border px-6 py-3'>
            <div className='min-w-0 truncate text-xs font-medium'>{title}</div>
            {/* No Raw JSON: it handed the session out as a file, and the
                screens hand out no files. No Archive button either: there
                is no per-session archive route (only POST
                /request-logs/sessions/archive, which takes all of them), so
                it sat permanently disabled behind a tooltip blaming the
                session for "still receiving calls" — shown just the same
                on one last seen three days ago. */}
          </div>
          <StatStrip summary={data.summary} />
          <div className='px-6 pt-5 pb-1'>
            <h2 className='text-[12px] font-semibold uppercase tracking-wider text-muted-foreground'>
              {t('activity.session.routingTrace')}
            </h2>
          </div>
          <TraceTable calls={data.calls} />
          <div className='h-10' />
        </div>
      )}
    </Screen>
  )
}

function preferredTitle(summary: SessionSummary, sessionId: string): string {
  const preview = summary.preview
  return preview === null || preview === '' ? sessionId : preview
}
