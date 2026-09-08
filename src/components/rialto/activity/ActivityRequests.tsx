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
import { type ActivityRequestLog, downloadCsv, fetchRequestLogs, percentile } from '@/components/rialto/activity/data'
import { COLUMNS, type ColumnId, ColumnMenu, RequestsTable } from '@/components/rialto/activity/RequestsTable'
import {
  applyFilters,
  type Filters,
  lane,
  options,
  RANGES,
  type Row,
  statusOptions
} from '@/components/rialto/activity/requests-rows'
import { FilterSelect, NoteBox, ScreenMessage, StatTile } from '@/components/rialto/activity/shared'
import { useActivityCounts } from '@/components/rialto/activity/use-activity-counts'
import { useSurfaces } from '@/components/rialto/activity/use-surfaces'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { api } from '@/lib/api'
import { fmtCount, fmtLatency, fmtRate } from '@/lib/rialto/format'

// The endpoint has no time filter, so the page is the newest N calls and
// every number on the screen describes that page.
const PAGE_SIZE = 200

/** The caller's name: the issued token when the row names one, else the
 *  surface's client label. */
const tokenNameOf = (id: string | null, names: Map<string, string>, fallback: string | null): string | null => {
  if (id === null) return fallback
  const name = names.get(id)
  return name === undefined ? fallback : name
}

// One refetch per burst: a busy stream fires an event per completed call.
const LIVE_REFRESH_MS = 2000

interface Counts {
  total: number
  ok: number
  rateLimited: number
  failed: number
  p50: number | null
  p95: number | null
}

function summarise(rows: Row[]): Counts {
  const statuses = rows.map((r) => r.log.status)
  const durations = rows.filter((r) => r.log.durationMs > 0).map((r) => r.log.durationMs)
  durations.sort((a, b) => a - b)
  return {
    total: rows.length,
    ok: statuses.filter((s) => s >= 200 && s < 300).length,
    rateLimited: statuses.filter((s) => s === 429).length,
    failed: statuses.filter((s) => s >= 400 && s !== 429).length,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95)
  }
}

function StatsRow({ counts, rangeLabel }: { counts: Counts; rangeLabel: string }) {
  const { t } = useTranslation()
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

export function ActivityRequests() {
  const { t } = useTranslation()
  const [page, setPage] = useState<{ items: ActivityRequestLog[]; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
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

  const load = useCallback(() => {
    fetchRequestLogs(PAGE_SIZE)
      .then((res) => {
        setPage(res)
        setNow(Date.now())
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [])

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

  const visible = useMemo(() => applyFilters(rows, filters, now), [rows, filters, now])
  const counts = useMemo(() => summarise(visible), [visible])
  const columns = useMemo(() => COLUMNS.filter((c) => !hidden.has(c.id)), [hidden])

  const range = RANGES.find((r) => r.id === filters.range)
  const rangeLabel = range === undefined ? '' : t(range.labelKey)
  // One scope, named. This line used to read "279 requests · 1 failovers
  // · newest 200": an all-time total, a failover count taken from the
  // filtered rows, and the page cap, with nothing saying they were three
  // different populations. The failover count lives in its own stat tile
  // just below, so the subtitle only has to answer "how much of what am I
  // looking at".
  const subtitle =
    page === null
      ? undefined
      : t('activity.requests.subtitle', {
          shown: fmtCount(counts.total),
          logged: fmtCount(page.total),
          range: rangeLabel
        })

  const exportCsv = () => {
    downloadCsv('rialto-requests.csv', [
      ['time', 'status', 'endpoint', 'requested', 'sent', 'rule', 'lane', 'input', 'output', 'ms', 'costUsd'],
      ...visible.map((r) => [
        r.log.createdAt,
        String(r.log.status),
        r.surfacePath === null ? '' : r.surfacePath,
        r.log.requestedModel === null ? '' : r.log.requestedModel,
        `${r.log.provider},${r.log.model}`,
        r.rule === null ? '' : r.rule,
        r.lane,
        String(r.log.totalInputTokens),
        String(r.log.outputTokens),
        String(r.log.durationMs),
        r.log.totalCostUsd === null ? '' : String(r.log.totalCostUsd)
      ])
    ])
  }

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
          onChange={(next) => setFilters((f) => ({ ...f, range: next }))}
        />
        <div className='ml-auto flex items-center gap-2'>
          {live ? (
            <span className='flex items-center gap-1.5 text-[12px] text-muted-foreground'>
              <span className='size-1.5 animate-pulse rounded-full bg-emerald-500' /> {t('activity.requests.live')}
            </span>
          ) : null}
          <RButton variant='ghost' icon='ri-download-line' onClick={exportCsv} disabled={visible.length === 0}>
            {t('activity.requests.export')}
          </RButton>
        </div>
      </div>

      <StatsRow counts={counts} rangeLabel={rangeLabel} />

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
