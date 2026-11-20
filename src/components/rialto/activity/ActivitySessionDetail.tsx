/** Request metadata, usage, and the upstream trace for one session. */
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { SessionStatsPhone } from '@/components/rialto/activity/SessionPhone'
import { SessionTrace } from '@/components/rialto/activity/SessionTrace'
import { ScreenMessage } from '@/components/rialto/activity/shared'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { usePhone } from '@/hooks/use-phone'
import { api, type SessionSummary } from '@/lib/api'
import { fmtAgo, fmtRate, shortId } from '@/lib/rialto/format'
import { fmtCost } from '@/lib/sessions/format'

/**
 * One figure, with its name above it.
 *
 * The strip reads left to right, so the label sits on top rather than
 * opposite: a row of nine `label ... value` pairs turned into a column
 * of ragged gaps the moment it stopped being 22rem wide.
 */
function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className='min-w-0'>
      <div className='text-[12px] text-muted-foreground'>{label}</div>
      <div className='mt-0.5 font-mono text-xs tabular-nums'>{value}</div>
    </div>
  )
}

/**
 * The session's numbers, across the top.
 *
 * These were nine rows down the right rail, above the call trace, on a
 * screen whose subject was the transcript beside them. Read left to right
 * they cost one line, and the width goes to the tabs below. Inbound is not
 * here because the breadcrumb already identifies the session.
 *
 * The cache hit rate is a figure like its neighbours, with no meter under
 * it: the percentage already says everything the bar did, and it was the
 * only figure in the strip that took a second line.
 */
function StatStrip({ summary }: { summary: SessionSummary }) {
  const { t } = useTranslation()
  const phone = usePhone()
  const totalInput = summary.totalInputTokens
  const cacheRate = totalInput === 0 ? null : summary.totalCacheReadTokens / totalInput
  // Seven figures wrapped to four rows on a phone; it gets the four that
  // are checked there, as a grid.
  if (phone) return <SessionStatsPhone summary={summary} />
  return (
    <div className='flex flex-wrap items-start gap-x-10 gap-y-3 border-b border-border px-6 py-3'>
      <Stat label={t('activity.session.upstreamCalls')} value={summary.requestCount} />
      <Stat label={t('activity.session.inputTokens')} value={summary.totalInputTokens.toLocaleString()} />
      <Stat label={t('activity.session.outputTokens')} value={summary.totalOutputTokens.toLocaleString()} />
      <Stat label={t('activity.session.cacheRead')} value={summary.totalCacheReadTokens.toLocaleString()} />
      <Stat label={t('activity.session.cacheHit')} value={fmtRate(cacheRate)} />
      <Stat label={t('activity.session.cost')} value={fmtCost(summary.totalCostUsd)} />
      <Stat label={t('activity.session.duration')} value={fmtAgo(summary.firstAt, Date.parse(summary.lastAt))} />
    </div>
  )
}

export function ActivitySessionDetail() {
  const { t } = useTranslation()
  const { sessionId = '' } = useParams()
  const navigate = useNavigate()
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [neighbours, setNeighbours] = useState<string[]>([])

  useEffect(() => {
    // A late answer for the session just left must not land on this one.
    const request = { stale: false }
    setSummary(null)
    setError(null)
    api
      .getSessionSummary(sessionId)
      .then((res) => {
        if (!request.stale) setSummary(res)
      })
      .catch((e: Error) => {
        if (!request.stale) setError(e.message)
      })
    return () => {
      request.stale = true
    }
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

  const index = neighbours.indexOf(sessionId)
  const prev = index > 0 ? neighbours[index - 1] : null
  const next = index >= 0 && index < neighbours.length - 1 ? neighbours[index + 1] : null
  const go = (target: string) => navigate(`/activity/sessions/${encodeURIComponent(target)}`)

  const title = summary === null ? shortId(sessionId) : preferredTitle(summary, shortId(sessionId))
  return (
    <Screen
      // Activity / Sessions / <id> — the third level the tree cannot name.
      crumbs={[{ label: shortId(sessionId) }]}
      actions={
        <>
          <RButton
            variant='outline'
            icon='ri-arrow-up-s-line'
            disabled={prev === null}
            onClick={() => prev !== null && go(prev)}
          >
            {t('activity.session.previous')}
          </RButton>
          <RButton
            variant='outline'
            icon='ri-arrow-down-s-line'
            disabled={next === null}
            onClick={() => next !== null && go(next)}
          >
            {t('common.next')}
          </RButton>
        </>
      }
    >
      {error !== null ? (
        <ScreenMessage tone='bad'>{error}</ScreenMessage>
      ) : summary === null ? (
        <ScreenMessage>{t('common.loading')}</ScreenMessage>
      ) : (
        <div className='min-w-0'>
          <div className='flex items-center gap-2 border-b border-border px-4 py-3 md:px-6'>
            <div className='min-w-0 truncate text-xs font-medium'>{title}</div>
            {/* No Raw JSON: it handed the session out as a file, and the
                screens hand out no files. No Archive button either: there
                is no per-session archive route (only POST
                /request-logs/sessions/archive, which takes all of them), so
                it sat permanently disabled behind a tooltip blaming the
                session for "still receiving calls" — shown just the same
                on one last seen three days ago. */}
          </div>
          <StatStrip summary={summary} />
          <SessionTrace key={sessionId} sessionId={sessionId} />
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
