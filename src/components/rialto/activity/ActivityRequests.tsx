/**
 * Activity › Requests — one row per upstream call.
 *
 * Where Sessions groups calls, this is the raw log. The three columns that
 * did not exist in the old UI are `Requested` / `Sent`, `Rule` and `Lane`:
 * the routing decision was written to the request log all along but was
 * only readable by grepping pino output.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useConfig } from '@/components/ConfigProvider'
import {
  type ActivityRequestLog,
  fetchRequestLogStats,
  fetchRequestLogs,
  type RequestLogStats
} from '@/components/rialto/activity/data'
import { COLUMNS, type ColumnId, ColumnMenu, RequestsTable } from '@/components/rialto/activity/RequestsTable'
import {
  applyFilters,
  type Filters,
  lane,
  options,
  RANGES,
  type Row,
  rangeHours,
  statusOptions
} from '@/components/rialto/activity/requests-rows'
import { FilterSelect, NoteBox, ScreenMessage, StatTile } from '@/components/rialto/activity/shared'
import { useActivityCounts } from '@/components/rialto/activity/use-activity-counts'
import { useSurfaces } from '@/components/rialto/activity/use-surfaces'
import { Pager } from '@/components/rialto/Pager'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { api } from '@/lib/api'
import { fmtLatency, fmtRate } from '@/lib/rialto/format'

// The endpoint has no time filter, so a page is N calls in recency order
// and every number on the screen describes the page on screen.
//
// 200 with no pager was a cap pretending to be a list: the subtitle said
// "184 of 18.7k" and there was no way to reach the other 18.5k. 25 to
// match Sessions, which pages the same archive.
const PAGE_SIZE = 25

/** The caller's name: the issued token when the row names one, else the
 *  surface's client label. */
const tokenNameOf = (id: string | null, names: Map<string, string>, fallback: string | null): string | null => {
  if (id === null) return fallback
  const name = names.get(id)
  return name === undefined ? fallback : name
}

// One refetch per burst: a busy stream fires an event per completed call.
const LIVE_REFRESH_MS = 2000

/**
 * The window's numbers, not the page's.
 *
 * `summarise` used to fold these out of the rows the table was showing,
 * so every tile described one page — 25 rows — while the first one was
 * labelled with the selected range. The aggregate now comes from the
 * server, which can see the whole window.
 *
 * `stats` is null only until the first response lands.
 */
function StatsRow({ stats, rangeLabel }: { stats: RequestLogStats | null; rangeLabel: string }) {
  const { t } = useTranslation()
  const counts: RequestLogStats = stats === null ? EMPTY_STATS : stats
  const share = (n: number): string => (counts.total === 0 ? '–' : fmtRate(n / counts.total))
  return (
    <div className='grid grid-cols-5 gap-px border-b border-border px-6 py-4'>
      <StatTile
        size='base'
        label={t('activity.requests.statRequests')}
        value={counts.total.toLocaleString()}
        sub={rangeLabel.toLowerCase()}
      />
      <StatTile size='base' label='2xx' value={counts.ok.toLocaleString()} sub={share(counts.ok)} />
      <StatTile
        size='base'
        label='429'
        value={counts.rateLimited.toLocaleString()}
        sub={t('activity.requests.statRateLimitedSub')}
      />
      <StatTile size='base' label='4xx / 5xx' value={counts.failed.toLocaleString()} sub={share(counts.failed)} />
      <StatTile
        size='base'
        label='p50 / p95'
        value={`${fmtLatency(counts.p50)} / ${fmtLatency(counts.p95)}`}
        sub={t('activity.requests.statLatencySub')}
      />
    </div>
  )
}

const EMPTY_STATS: RequestLogStats = { total: 0, ok: 0, rateLimited: 0, failed: 0, p50: null, p95: null }

export function ActivityRequests() {
  const { t } = useTranslation()
  const [page, setPage] = useState<{ items: ActivityRequestLog[]; total: number } | null>(null)
  const [stats, setStats] = useState<RequestLogStats | null>(null)
  const [pageIndex, setPageIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // The mock ships this screen tailing: a request log that does not move
  // while requests are being served is the wrong default.
  const [live, setLive] = useState(true)
  const [hidden, setHidden] = useState<Set<ColumnId>>(new Set())
  const [filters, setFilters] = useState<Filters>({
    surface: 'all',
    status: 'all',
    client: 'all',
    rule: 'all',
    range: '24h'
  })
  const throttle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const surfaces = useSurfaces()
  // Whether the archive this screen reads is even being written.
  const { config } = useConfig()
  const captureOff = config !== null && config.CAPTURE_REQUESTS === false
  // id -> name for the issued tokens, fetched once. A revoked or deleted
  // token leaves rows behind, so a missing id falls back rather than
  // blanking the column.
  const [tokenNames, setTokenNames] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    let mounted = true
    api
      .getAccessTokens()
      .then((res) => {
        if (mounted) setTokenNames(new Map(res.tokens.map((tk) => [tk.id, tk.name])))
      })
      .catch(() => {})
    return () => {
      mounted = false
    }
  }, [])
  const _tabCounts = useActivityCounts()

  const hours = rangeHours(filters.range)

  const load = useCallback(() => {
    // Two calls, one window. The page is what the table draws; the
    // aggregate is what the tiles claim, and it has to come from the
    // server because the window is bigger than any page.
    fetchRequestLogs(PAGE_SIZE, pageIndex * PAGE_SIZE, hours)
      .then((res) => {
        setPage(res)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
    fetchRequestLogStats(hours)
      .then(setStats)
      // A missing aggregate leaves the tiles at their last good values
      // rather than replacing the table's error with a second one.
      .catch(() => {})
  }, [pageIndex, hours])

  useEffect(load, [load])

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
    es.onmessage = () => {
      if (throttle.current !== null) return
      throttle.current = setTimeout(() => {
        throttle.current = null
        load()
      }, LIVE_REFRESH_MS)
    }
    // Left open on error: EventSource reconnects itself.
    return () => {
      es.close()
      if (throttle.current !== null) clearTimeout(throttle.current)
      throttle.current = null
    }
  }, [live, load])

  const rows = useMemo<Row[]>(() => {
    if (page === null) return []
    return page.items.map((log) => ({
      log,
      surfacePath: surfaces.pathOf(log.surface),
      // The issued token that actually made the call, when the row names
      // one. Falling straight through to the surface's client label made
      // this column a copy of Surface — every /v1/messages row read
      // "Claude Code" — so "which of my three tokens is spending this?"
      // could not be asked, although the row had the answer all along.
      client: tokenNameOf(log.accessTokenId, tokenNames, surfaces.clientOf(log.surface)),
      lane: lane(log.isSubagent),
      // No Rule entity exists yet; the scenario IS the routing decision
      // that matched, so it fills this column until rules are persisted.
      rule: log.scenario
    }))
  }, [page, surfaces.pathOf, surfaces.clientOf, tokenNames])

  const visible = useMemo(() => applyFilters(rows, filters), [rows, filters])
  const columns = useMemo(() => COLUMNS.filter((c) => !hidden.has(c.id)), [hidden])

  const range = RANGES.find((r) => r.id === filters.range)
  const rangeLabel = range === undefined ? '' : t(range.labelKey)
  // One scope, named: the window, nothing else. This used to read "279
  // requests · 1 failovers · newest 200" — an all-time total, a failover
  // count taken from the filtered rows, and the page cap, three different
  // populations with nothing saying so. Both the total and the failover
  // count live in their own stat tiles just below, so the subtitle only
  // has to answer "what window am I looking at".
  const subtitle = rangeLabel === '' ? undefined : rangeLabel.toLowerCase()

  return (
    <Screen
      subtitle={subtitle}
      actions={
        <>
          <RButton variant='outline' icon='ri-broadcast-line' aria-pressed={live} onClick={() => setLive((v) => !v)}>
            {t('activity.requests.liveTail')}
          </RButton>
          <ColumnMenu hidden={hidden} onChange={setHidden} />
        </>
      }
    >
      <div className='flex flex-wrap items-center gap-2 border-b border-border px-6 py-3'>
        <FilterSelect
          label={t('activity.requests.filterSurface')}
          value={filters.surface}
          options={options(
            surfaces.surfaces.map((s) => s.path),
            t('activity.common.all')
          )}
          onChange={(surface) => setFilters((f) => ({ ...f, surface }))}
        />
        <FilterSelect
          label={t('activity.requests.filterStatus')}
          value={filters.status}
          options={statusOptions(t('activity.common.all'))}
          onChange={(status) => setFilters((f) => ({ ...f, status }))}
        />
        <FilterSelect
          label={t('activity.requests.filterToken')}
          value={filters.client}
          options={options(
            rows.map((r) => r.client),
            t('activity.common.all')
          )}
          onChange={(client) => setFilters((f) => ({ ...f, client }))}
        />
        <FilterSelect
          label={t('activity.requests.filterRule')}
          value={filters.rule}
          options={options(
            rows.map((r) => r.rule),
            t('activity.common.all')
          )}
          onChange={(rule) => setFilters((f) => ({ ...f, rule }))}
        />
        <FilterSelect
          label={t('activity.requests.filterRange')}
          value={filters.range}
          options={RANGES.map((r) => ({ id: r.id, label: t(r.labelKey) }))}
          onChange={(next) => {
            // A narrower window may not have the page the viewer is
            // standing on, and an offset past the end returns nothing at
            // all — which reads as "no requests" rather than "wrong page".
            setPageIndex(0)
            setFilters((f) => ({ ...f, range: next }))
          }}
        />
        <div className='ml-auto flex items-center gap-2'>
          {live ? (
            <span className='flex items-center gap-1.5 text-[12px] text-muted-foreground'>
              <span className='size-1.5 animate-pulse rounded-full bg-emerald-500' /> {t('activity.requests.live')}
            </span>
          ) : null}
        </div>
      </div>

      <StatsRow stats={stats} rangeLabel={rangeLabel} />

      {error !== null ? (
        <ScreenMessage tone='bad'>{error}</ScreenMessage>
      ) : page === null ? (
        <ScreenMessage>{t('common.loading')}</ScreenMessage>
      ) : visible.length === 0 ? (
        <ScreenMessage>
          {/* An empty table because capture is switched off looks exactly
              like a broken screen. Name the switch and link to it. */}
          {captureOff ? (
            <Trans
              i18nKey='activity.requests.captureOff'
              components={{ settings: <Link to='/settings/logging' className='underline' /> }}
            />
          ) : (
            t('activity.requests.empty')
          )}
        </ScreenMessage>
      ) : (
        <RequestsTable rows={visible} columns={columns} />
      )}

      {/* `loaded` counts the fetched page, not the filtered rows: the
          filters run client-side over one page, so measuring them would
          make Next disappear whenever a filter hid the tail of a page
          that has more behind it. */}
      {page === null ? null : (
        <Pager
          page={pageIndex}
          pageSize={PAGE_SIZE}
          loaded={page.items.length}
          total={page.total}
          onPage={setPageIndex}
        />
      )}

      <div className='px-6 py-4'>
        <NoteBox>
          <Trans
            i18nKey='activity.requests.note'
            components={{ mono: <span className='font-mono' />, strong: <span className='font-medium' /> }}
          />
        </NoteBox>
      </div>
      <div className='h-6' />
    </Screen>
  )
}
