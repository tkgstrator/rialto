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
import { fetchUsageCost, summariseUsageCost, type WindowTotals } from '@/components/rialto/activity/data'
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
import { useConfirm } from '@/components/rialto/ConfirmDialog'
import { Pager } from '@/components/rialto/Pager'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { api, type SessionSummary } from '@/lib/api'
import { splitConfirmMessage } from '@/lib/rialto/confirm-message'
import { fmtRate } from '@/lib/rialto/format'
import { fmtCost, fmtTokens } from '@/lib/sessions/format'

// The screen used to join the newest 500 request-log rows onto the
// session list. That join existed for the trend sparkline and nothing
// else — every other cell, `surface` included, comes from the session
// aggregate — so with the column gone the fetch went with it, and a page
// of 25 sessions costs one query instead of three.

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

export function ActivitySessions() {
  const { t } = useTranslation()
  const [range, setRange] = useState<RangeId>('7d')
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [totals, setTotals] = useState<WindowTotals | null>(null)
  const [totalSessions, setTotalSessions] = useState<number | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [surfaceFilter, setSurfaceFilter] = useState<string>(ALL)
  const [providerFilter, setProviderFilter] = useState<string>(ALL)
  const [modelFilter, setModelFilter] = useState<string>(ALL)
  const [page, setPage] = useState(0)
  const [live, setLive] = useState(false)
  const surfaces = useSurfaces()

  const load = useCallback(() => {
    const spec = rangeSpec(range)
    Promise.all([
      api.getRequestLogSessions({ limit: SESSION_PAGE, offset: page * SESSION_PAGE, sinceHours: spec.hours }),
      fetchUsageCost(spec.days)
    ])
      .then(([sessionRes, costRes]) => {
        setSessions(sessionRes.sessions)
        setTotalSessions(sessionRes.total)
        setTotals(summariseUsageCost(costRes))
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

  const rows = useMemo(() => (sessions === null ? [] : enrich(sessions, surfaces.pathOf)), [sessions, surfaces.pathOf])
  const visible = useMemo(
    () => applyFilters(rows, { surface: surfaceFilter, provider: providerFilter, model: modelFilter }),
    [rows, surfaceFilter, providerFilter, modelFilter]
  )

  const spec = rangeSpec(range)
  const rangeLabel = t(spec.labelKey)

  const { confirm, dialog: confirmDialog } = useConfirm()

  const archiveAll = async () => {
    const { title, description } = splitConfirmMessage(t('activity.sessions.archiveConfirm'))
    const confirmed = await confirm({
      title,
      description,
      confirmLabel: t('activity.sessions.archive'),
      icon: 'ri-archive-line'
    })
    if (!confirmed) return
    // The confirm makes this the one destructive action on the screen, and
    // a rejected archive re-reads the same rows — identical to a click that
    // never landed. It has to say which of the two happened.
    void api
      .archiveAllSessions()
      .then(load)
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
  }

  return (
    <Screen
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
          {/* Ghost, not red: archiving files sessions away rather than
              deleting them — their request logs stay — so it does not read
              as the same kind of irreversible action as Remove elsewhere. */}
          <RButton variant='ghost' icon='ri-archive-line' onClick={archiveAll}>
            {t('activity.sessions.archive')}
          </RButton>
          {/* Portalled, so its place in the tree changes nothing on screen;
              beside the button that opens it is where a reader looks. */}
          {confirmDialog}
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
            rows.flatMap((r) => r.session.models.map((m) => m.name)),
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
        {/* No search box and no Export. A text field here could only match
            the session id and the prompt preview, and neither is on the
            table any more; the three selects narrow by what the rows
            actually show. Export stays on Requests, where a row is a
            measurement someone takes away. */}
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
          <SessionsTable rows={visible} />
          <Pager page={page} pageSize={SESSION_PAGE} loaded={sessions.length} total={totalSessions} onPage={setPage} />
        </>
      )}
      <div className='h-10' />
    </Screen>
  )
}
