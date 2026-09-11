/**
 * Activity › Session — what one session cost, where each of its calls
 * went, and what was said.
 *
 * The routing trace and the conversation are two tabs rather than two
 * panes. Side by side, the transcript took the wide column and squeezed
 * the trace — the one thing this screen knows that no other screen does —
 * into a 22rem rail that could only show its last five rows; the fix then
 * dropped the transcript altogether, which left a store of conversations
 * with no way to read them. A tab gives each the full width.
 *
 * Tab state rides on the query string, as on Settings › Advanced, so a tab
 * is linkable and Previous / Next keep the reader on the tab they chose.
 */
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { SessionConversation } from '@/components/rialto/activity/SessionConversation'
import { SessionTrace } from '@/components/rialto/activity/SessionTrace'
import { ScreenMessage } from '@/components/rialto/activity/shared'
import { useSurfaces } from '@/components/rialto/activity/use-surfaces'
import { RButton, Tabs } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { api, type SessionSummary } from '@/lib/api'
import { fmtAgo, fmtRate, shortId } from '@/lib/rialto/format'
import { fmtCost } from '@/lib/sessions/format'

const TABS = [
  { id: 'trace', labelKey: 'activity.session.routingTrace', href: '?tab=trace' },
  { id: 'conversation', labelKey: 'activity.session.conversation', href: '?tab=conversation' }
] as const

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
 * These were nine rows down the right rail, above the routing trace, on a
 * screen whose subject was the transcript beside them. Read left to right
 * they cost one line, and the width goes to the tabs below. Inbound is not
 * here because the subtitle already says it.
 *
 * The cache hit rate is a figure like its neighbours, with no meter under
 * it: the percentage already says everything the bar did, and it was the
 * only figure in the strip that took a second line.
 */
function StatStrip({ summary }: { summary: SessionSummary }) {
  const { t } = useTranslation()
  const totalInput = summary.totalInputTokens
  const cacheRate = totalInput === 0 ? null : summary.totalCacheReadTokens / totalInput
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
  const { search } = useLocation()
  const [params] = useSearchParams()
  const tab = params.get('tab') === 'conversation' ? 'conversation' : 'trace'
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [neighbours, setNeighbours] = useState<string[]>([])
  const surfaces = useSurfaces()

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

  const inboundPath = summary === null ? null : surfaces.pathOf(summary.surface)

  const index = neighbours.indexOf(sessionId)
  const prev = index > 0 ? neighbours[index - 1] : null
  const next = index >= 0 && index < neighbours.length - 1 ? neighbours[index + 1] : null
  const go = (target: string) => navigate({ pathname: `/activity/sessions/${encodeURIComponent(target)}`, search })

  // Short everywhere it is read rather than routed on: the raw uuid is
  // still what Previous/Next and the fetch use, but the breadcrumb,
  // subtitle and title-fallback are read by a person, the same as the
  // Sessions table's own `shortId` column.
  const title = summary === null ? shortId(sessionId) : preferredTitle(summary, shortId(sessionId))
  const subtitle =
    summary === null
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
            onClick={() => prev !== null && go(prev)}
          >
            {t('activity.session.previous')}
          </RButton>
          <RButton
            variant='ghost'
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
          <StatStrip summary={summary} />
          <div className='flex items-center gap-1 border-b border-border px-6'>
            <Tabs
              items={TABS.map((item) => ({ id: item.id, label: t(item.labelKey), href: item.href }))}
              active={tab}
            />
          </div>
          {/* Keyed by session: the header's Previous / Next reuse this
              screen, and the next session should open on its newest page
              rather than on whatever page the last one was left at. */}
          {tab === 'conversation' ? (
            <SessionConversation key={sessionId} sessionId={sessionId} />
          ) : (
            <SessionTrace key={sessionId} sessionId={sessionId} />
          )}
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
