/**
 * Activity › Sessions — one row per conversation.
 *
 * Absorbs the old Sessions grid, Usage and ApiCost: they answered the same
 * question ("where did the traffic and the money go") at three zoom levels
 * and forced the operator to hold three screens in their head at once.
 *
 * The headline tiles come from the server-side /api/usage/cost aggregate,
 * not from the loaded page, so they describe the whole window even though
 * the table is paginated.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  type ActivityRequestLog,
  downloadCsv,
  fetchRequestLogs,
  fetchUsageCost,
  summariseUsageCost,
  type WindowTotals
} from '@/components/rialto/activity/data'
import { SessionsTable } from '@/components/rialto/activity/SessionsTable'
import {
  ALL,
  applyFilters,
  enrich,
  options,
  parseSessionId,
  RANGES,
  type RangeId,
  rangeSpec,
  upsertSession
} from '@/components/rialto/activity/sessions-derive'
import { FilterSelect, ScreenMessage, StatTile } from '@/components/rialto/activity/shared'
import { useSurfaces } from '@/components/rialto/activity/use-surfaces'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { api, type SessionSummary } from '@/lib/api'
import { fmtCount, fmtRate } from '@/lib/rialto/format'
import { fmtCost, fmtTokens } from '@/lib/sessions/format'

// Newest calls joined onto the session rows for the trend column alone.
// The session aggregate carries no time series; everything else on the
// row, `surface` included, comes from the aggregate itself.
const JOIN_LOG_LIMIT = 500

// One screenful. The endpoint pages server-side (`limit` / `offset` and a
// `total`), so this is the page size rather than a ceiling on what the
// screen can ever show — which is what 100 was.
const SESSION_PAGE = 25

function StatsRow({ totals, rangeLabel }: { totals: WindowTotals | null; rangeLabel: string }) {
  const { t } = useTranslation()
  return (
    <div className='grid grid-cols-4 gap-px border-b border-border px-6 py-4'>
      <StatTile
        label={t('activity.sessions.statRequests')}
        value={totals === null ? '–' : totals.requests.toLocaleString()}
        sub={rangeLabel.toLowerCase()}
      />
      <StatTile
        label={t('activity.sessions.statTokens')}
        value={totals === null ? '–' : fmtTokens(totals.tokens)}
        sub={t('activity.sessions.statTokensSub')}
      />
      <StatTile
        label={t('activity.sessions.statCost')}
        value={totals === null ? '–' : fmtCost(totals.apiKeyCostUsd)}
        sub={t('activity.sessions.statCostSub')}
      />
      <StatTile
        label={t('activity.sessions.statCacheHit')}
        value={totals === null ? '–' : fmtRate(totals.cacheHitRate)}
        sub={t('activity.sessions.statCacheHitSub')}
      />
    </div>
  )
}

/**
 * Server-side paging over the session list.
 *
 * The range reads "26–50 of 128" rather than a page number: a page
 * number only means something once you know the page size, and the two
 * questions an operator has here are where they are and how much is
 * left. `total` is the count for the whole time window, so it stays
 * honest while the filters below narrow what is on screen.
 *
 * The column sort applies to the page, not the window — the endpoint
 * orders by recency and takes no sort parameter. That is why paging
 * exists rather than a bigger fetch: 100 rows sorted client-side was
 * still an arbitrary 100.
 */
function Pager({
  page,
  pageSize,
  loaded,
  total,
  onPage
}: {
  page: number
  pageSize: number
  loaded: number
  total: number | undefined
  onPage: (next: number) => void
}) {
  const { t } = useTranslation()
  const first = page * pageSize + 1
  const last = page * pageSize + loaded
  const hasNext = total === undefined ? loaded === pageSize : last < total
  if (page === 0 && !hasNext) return null
  return (
    <div className='flex items-center gap-3 border-t border-border px-6 py-3'>
      <span className='text-[12px] text-muted-foreground'>
        {total === undefined
          ? t('activity.sessions.rangeUnknownTotal', { first, last })
          : t('activity.sessions.range', { first, last, total })}
      </span>
      <div className='ml-auto flex items-center gap-2'>
        <RButton variant='ghost' icon='ri-arrow-left-s-line' disabled={page === 0} onClick={() => onPage(page - 1)}>
          {t('common.previous')}
        </RButton>
        <RButton variant='ghost' disabled={!hasNext} onClick={() => onPage(page + 1)}>
          {t('common.next')}
        </RButton>
      </div>
    </div>
  )
}

export function ActivitySessions() {
  const { t } = useTranslation()
  const [range, setRange] = useState<RangeId>('7d')
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [logs, setLogs] = useState<ActivityRequestLog[]>([])
  const [totals, setTotals] = useState<WindowTotals | null>(null)
  const [totalSessions, setTotalSessions] = useState<number | undefined>(undefined)
  const [_totalRequests, setTotalRequests] = useState<number | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  // Frozen per load so every "last seen" label on the page is measured
  // from the instant the data describes.
  const [now, setNow] = useState(Date.now())
  const [surfaceFilter, setSurfaceFilter] = useState<string>(ALL)
  const [providerFilter, setProviderFilter] = useState<string>(ALL)
  const [modelFilter, setModelFilter] = useState<string>(ALL)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [live, setLive] = useState(false)
  const surfaces = useSurfaces()

  const load = useCallback(() => {
    const spec = rangeSpec(range)
    Promise.all([
      api.getRequestLogSessions({ limit: SESSION_PAGE, offset: page * SESSION_PAGE, sinceHours: spec.hours }),
      fetchUsageCost(spec.days),
      fetchRequestLogs(JOIN_LOG_LIMIT)
    ])
      .then(([sessionRes, costRes, logRes]) => {
        setSessions(sessionRes.sessions)
        setTotalSessions(sessionRes.total)
        setTotals(summariseUsageCost(costRes))
        setLogs(logRes.items)
        setTotalRequests(logRes.total)
        setNow(Date.now())
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [range, page])

  useEffect(load, [load])

  // Live tail. Patching only the session the event names keeps the table
  // from re-rendering on every streamed token, which is what a blanket
  // re-fetch would do.
  useEffect(() => {
    if (!live) return
    // No credential in the URL. The `apikey` query parameter existed
    // because EventSource cannot set headers, back when the browser held
    // a key it had typed into the login form. That form is gone (Phase
    // 3.5: Cloudflare Access authenticates at the edge, local requests are
    // trusted), so nothing writes `localStorage.apiKey` any more — the
    // guard that read it was permanently true and this feature had
    // silently stopped connecting at all. EventSource is same-origin, so
    // it carries the Access cookie exactly like every other /api/* call
    // this screen already makes.
    const es = new EventSource('/api/request-logs/events')
    es.onmessage = (e) => {
      const sessionId = parseSessionId(e.data)
      if (sessionId === null) return
      // Unhandled on purpose: this fires once per streamed log line, so a
      // toast per failure would bury the screen during a busy minute. A
      // dropped summary costs one stale row until the next event for that
      // session, and the operator can still reload.
      void api.getSessionSummary(sessionId).then((summary) => {
        setSessions((prev) => (prev === null ? prev : upsertSession(prev, summary)))
      })
    }
    // Left open on error: EventSource reconnects itself after a transient
    // network failure.
    return () => es.close()
  }, [live])

  const rows = useMemo(
    () => (sessions === null ? [] : enrich(sessions, logs, surfaces.pathOf)),
    [sessions, logs, surfaces.pathOf]
  )
  const visible = useMemo(
    () => applyFilters(rows, { surface: surfaceFilter, provider: providerFilter, model: modelFilter, query }),
    [rows, surfaceFilter, providerFilter, modelFilter, query]
  )

  const spec = rangeSpec(range)
  const rangeLabel = t(spec.labelKey)
  const subtitle =
    sessions === null
      ? undefined
      : t('activity.sessions.subtitle', {
          sessions: fmtCount(totalSessions === undefined ? sessions.length : totalSessions),
          requests: totals === null ? '–' : fmtCount(totals.requests),
          range: rangeLabel.toLowerCase()
        })

  const archiveAll = () => {
    if (!window.confirm(t('activity.sessions.archiveConfirm'))) return
    // The confirm makes this the one destructive action on the screen, and
    // a rejected archive re-reads the same rows — identical to a click that
    // never landed. It has to say which of the two happened.
    void api
      .archiveAllSessions()
      .then(load)
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
  }

  const exportCsv = () => {
    downloadCsv('rialto-sessions.csv', [
      ['session', 'endpoint', 'model', 'calls', 'input', 'output', 'cachePct', 'costUsd', 'lastAt'],
      ...visible.map((r) => [
        r.session.sessionId,
        r.surfacePath === null ? '' : r.surfacePath,
        r.model === null ? '' : r.model,
        String(r.session.requestCount),
        String(r.session.totalInputTokens),
        String(r.session.totalOutputTokens),
        String(r.session.avgCacheHitPct),
        r.session.totalCostUsd === null ? '' : String(r.session.totalCostUsd),
        r.session.lastAt
      ])
    ])
  }

  return (
    <Screen
      subtitle={subtitle}
      actions={
        <>
          <RButton
            variant='outline'
            icon='ri-broadcast-line'
            aria-pressed={live}
            onClick={() => setLive((v) => !v)}
            className={live ? 'bg-muted/60' : ''}
          >
            {t('activity.sessions.liveTail')}
          </RButton>
          <RButton variant='ghost' icon='ri-archive-line' onClick={archiveAll}>
            {t('activity.sessions.archive')}
          </RButton>
        </>
      }
    >
      <div className='flex flex-wrap items-center gap-2 border-b border-border px-6 py-3'>
        <FilterSelect
          label={t('activity.sessions.filterSurface')}
          value={surfaceFilter}
          options={options(
            surfaces.surfaces.map((s) => s.path),
            t('activity.common.all')
          )}
          onChange={setSurfaceFilter}
        />
        <FilterSelect
          label={t('activity.sessions.filterProvider')}
          value={providerFilter}
          options={options(
            rows.flatMap((r) => r.session.providers),
            t('activity.common.all')
          )}
          onChange={setProviderFilter}
        />
        <FilterSelect
          label={t('activity.sessions.filterModel')}
          value={modelFilter}
          options={options(
            rows.flatMap((r) => r.session.models),
            t('activity.common.all')
          )}
          onChange={setModelFilter}
        />
        <FilterSelect
          label={t('activity.sessions.filterRange')}
          value={range}
          options={RANGES.map((r) => ({ id: r.id, label: t(r.labelKey) }))}
          onChange={setRange}
        />
        <div className='ml-auto flex items-center gap-2'>
          <div className='flex h-7 w-56 items-center gap-2 rounded-md border border-border px-2.5 text-xs text-muted-foreground'>
            <i className='ri-search-line text-sm' />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('activity.sessions.searchPlaceholder')}
              className='min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground'
            />
          </div>
          <RButton variant='ghost' icon='ri-download-line' onClick={exportCsv} disabled={visible.length === 0}>
            {t('activity.sessions.export')}
          </RButton>
        </div>
      </div>

      <StatsRow totals={totals} rangeLabel={rangeLabel} />

      {error !== null ? (
        <ScreenMessage tone='bad'>{error}</ScreenMessage>
      ) : sessions === null ? (
        <ScreenMessage>{t('common.loading')}</ScreenMessage>
      ) : visible.length === 0 ? (
        <ScreenMessage>{t('activity.sessions.empty')}</ScreenMessage>
      ) : (
        <>
          <SessionsTable rows={visible} now={now} />
          <Pager page={page} pageSize={SESSION_PAGE} loaded={sessions.length} total={totalSessions} onPage={setPage} />
        </>
      )}
      <div className='h-10' />
    </Screen>
  )
}
