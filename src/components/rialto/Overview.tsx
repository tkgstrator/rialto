/**
 * Overview — the one-page answer to "is Rialto doing what I set it up to
 * do right now".
 *
 * The headline is the four inbound surfaces, because that is Rialto's
 * identity (four wire formats in, many vendors out) and because the old
 * build gave the operator no way to see that only one of them was
 * actually routed.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { Meter, Mono, Pill, RButton, Section, SurfacePill } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  api,
  type OverviewFailoverRow,
  type OverviewQuotaRow,
  type OverviewResponse,
  type OverviewSpendRow
} from '@/lib/api'
import { fmtAgo, fmtCount, fmtLatency, fmtRate, fmtUntil, shortId } from '@/lib/rialto/format'
import { fmtCost, fmtTokens } from '@/lib/sessions/format'
import { cn } from '@/lib/utils'

// Spend is going up or down, and neither direction is an alarm on its
// own — a rise past a tenth is the one worth colouring.
const deltaTone = (ratio: number): 'warn' | 'ok' | 'mute' => {
  if (ratio > 0.1) return 'warn'
  if (ratio < 0) return 'ok'
  return 'mute'
}

const fmtDelta = (ratio: number): string => `${ratio > 0 ? '+' : ''}${Math.round(ratio * 100)}%`

const SPEND_LABEL_KEYS: Record<OverviewSpendRow['label'], string> = {
  today: 'overview.spendToday',
  week: 'overview.spendWeek',
  month: 'overview.spendMonth',
  savedBySubscription: 'overview.spendSaved'
}

/**
 * The window the whole page describes.
 *
 * The mock draws this as a static "Last 24h" button and the first build
 * shipped it inert, so the one control in the header did nothing while
 * `/api/overview` had accepted `windowHours` up to 720 all along.
 */
const RANGES: readonly { hours: number; labelKey: string }[] = [
  { hours: 1, labelKey: 'activity.requests.range1h' },
  { hours: 24, labelKey: 'activity.requests.range24h' },
  { hours: 24 * 7, labelKey: 'activity.requests.range7d' },
  { hours: 24 * 30, labelKey: 'activity.sessions.range30d' }
]

/** Where a failover row's subject is explained in full. */
const failoverHref = (f: OverviewFailoverRow): string => (f.kind === 'rate_limit' ? '/activity/requests' : '/routing')

/**
 * Every row on this page is a question whose answer lives on another
 * screen, which is why the mock gives all of them a hover state. Getting
 * the cursor right matters: the first build kept the hover and dropped
 * the destination, so the landing page highlighted six regions that did
 * nothing when clicked.
 */
const ROW_LINK = 'transition-colors hover:bg-muted/50 cursor-pointer'

/**
 * One row of the failover feed.
 *
 * The two kinds share a layout but not a sentence, so each half picks its
 * own copy. Composing here rather than on the server is what lets a JA
 * install read this panel in Japanese, and what turns the scheduler's
 * `reason` slug into something an operator can act on.
 */
/**
 * One subscription account and every limit it is under.
 *
 * Nothing is marked as "the one that matters". Anthropic's `limits[]`
 * rows carry an `is_active` flag and it is tempting to badge, but its
 * meaning is not documented and a live sample cannot settle it: session
 * 25% inactive, weekly_all 63% active, weekly_scoped 8% inactive, which
 * is neither "highest percent" nor "one per group". A badge nobody can
 * explain is worse than no badge.
 *
 * The order is ours and is explainable: shortest window first, per-model
 * rows under the 7d they belong to.
 *
 * The account line carries no percentage. It used to show the worst
 * window's, which nothing on the row said — beside a list where every
 * line already shows its own, an unlabelled number in the corner is a
 * question rather than an answer.
 */
function QuotaAccount({ row, now }: { row: OverviewQuotaRow; now: number }) {
  const { t } = useTranslation()
  return (
    <Link to='/activity/usage' className={cn('block border-t border-border/60 px-6 py-3', ROW_LINK)}>
      <div className='flex items-baseline gap-2'>
        <span className='text-xs font-medium'>{row.account}</span>
        {/* `count` rather than the `{{n}}` the neighbouring counters use:
            "1 limits" is wrong, and this one really can be 1. i18next
            reads the _one/_other pair; the plain key is there because the
            locale-parity test scans for the literal string in the source
            and cannot know about plural suffixes. */}
        <span className='text-[12px] text-muted-foreground/70'>
          {t('overview.quotaLimitCount', { count: row.windows.length })}
        </span>
      </div>
      <div className='mt-2'>
        {row.windows.map((w) => (
          <div key={`${w.window}-${w.scope}`} className='flex items-baseline gap-3 pt-2 first:pt-0'>
            <span className='w-28 shrink-0 font-mono text-[12px] text-muted-foreground'>
              {w.scope === null ? w.window : `${w.window} · ${w.scope}`}
            </span>
            {/* Capped, not stretched: full width, a 63% bar and a 65% bar
                are impossible to tell apart and the number that matters
                ends up a pane away from its label. */}
            <div className='w-64 shrink-0'>
              <Meter pct={w.pct} />
            </div>
            <span className='w-10 shrink-0 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
              {w.pct}%
            </span>
            {/* A window whose reset time has passed is waiting on the
                next poll, not resetting "in" anything — but the full
                sentence wrapped to four lines in a 5rem cell, so the
                column says "due" and the title carries the rest. */}
            <span
              className='w-20 shrink-0 truncate text-right font-mono text-[12px] tabular-nums text-muted-foreground'
              title={fmtUntil(w.resetAt, now) === null ? t('overview.resetsDue') : undefined}
            >
              {fmtUntil(w.resetAt, now) === null ? t('overview.resetsDueShort') : fmtUntil(w.resetAt, now)}
            </span>
          </div>
        ))}
      </div>
    </Link>
  )
}

function FailoverEntry({ row, now }: { row: OverviewFailoverRow; now: number }) {
  const { t } = useTranslation()
  const rateLimited = row.kind === 'rate_limit'

  const label = rateLimited ? (row.status === null ? '429' : String(row.status)) : t('overview.failoverWeightLabel')

  // What moved. The target on its own line, the values in a fixed slot so
  // a column of moves can be compared instead of read one at a time.
  const subject = rateLimited ? row.account : row.target

  // A 429 has no transition: the row carries account, status and
  // Retry-After and nothing else. Nothing records which target picked the
  // traffic up, so this says what it has rather than inventing a
  // destination.
  // Why, in words, on its own line. The mock drew the scheduler's slug in
  // a narrow column; the schema calls `reason` a "machine slug, i18n-able
  // on the UI side" and the translation is a sentence, so a 7rem column
  // truncated it to "its quota is r…". The transition is what earns a
  // column here — the reason is what earns a line.
  const detail = rateLimited
    ? row.retryAfterSec === null
      ? t('overview.failoverNoRetryAfter')
      : t('overview.failoverRetryAfter', { secs: row.retryAfterSec })
    : t(`overview.weightReason.${row.reason}`, { defaultValue: t('overview.weightReason.unknown') })

  return (
    <Link to={failoverHref(row)} className={cn('block border-t border-border/60 px-6 py-3', ROW_LINK)}>
      <div className='flex items-baseline gap-3'>
        <span className='w-14 shrink-0'>
          <Pill tone={row.tone}>{label}</Pill>
        </span>
        <span className='min-w-0 flex-1 truncate font-mono text-xs'>{subject}</span>
        <span className='w-32 shrink-0 text-right'>
          {row.fromWeight === null || row.toWeight === null ? null : (
            <span className='inline-flex items-baseline gap-1.5 font-mono text-xs tabular-nums'>
              <span className='text-muted-foreground/70'>{row.fromWeight.toFixed(2)}</span>
              <i className='ri-arrow-right-line text-[11px] text-muted-foreground/50' />
              <span className='font-medium text-foreground'>{row.toWeight.toFixed(2)}</span>
            </span>
          )}
        </span>
        {/* A duration is a number: mono and tabular like every other
            figure here. In the proportional face "1h ago" and "46m ago"
            are different widths, so a column of them does not line up. */}
        <span className='w-16 shrink-0 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
          {row.at === '' ? '' : t('settings.access.lastUsedAgo', { ago: fmtAgo(row.at, now) })}
        </span>
      </div>
      {detail === null ? null : <div className='mt-1 pl-[4.25rem] text-[12px] text-muted-foreground'>{detail}</div>}
    </Link>
  )
}

function SurfaceTable({ data }: { data: OverviewResponse }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <table className='w-full table-fixed'>
      <colgroup>
        <col />
        <col className='w-32' />
        <col className='w-28' />
        <col className='w-20' />
        <col className='w-24' />
      </colgroup>
      <thead>
        <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2'>
          <th className='pl-6 pr-3 text-left font-medium'>{t('overview.colSurface')}</th>
          <th className='px-3 text-left font-medium'>{t('overview.colRouting')}</th>
          <th className='px-3 text-right font-medium'>{t('overview.colRequests')}</th>
          <th className='px-3 text-right font-medium'>p50</th>
          <th className='pl-3 pr-6 text-right font-medium'>{t('overview.colErrors')}</th>
        </tr>
      </thead>
      <tbody>
        {data.surfaces.map((s) => (
          <tr
            key={s.id}
            className={cn('border-t border-border/60', ROW_LINK)}
            onClick={() => navigate(`/routing?surface=${s.id}`)}
          >
            <td className='py-2.5 pl-6 pr-3'>
              {/* The link carries the row for the keyboard; the row's own
                  onClick is the pointer affordance the hover promises. */}
              <Link to={`/routing?surface=${s.id}`} className='font-mono text-xs hover:underline'>
                {s.path}
              </Link>
              <div className='text-[12px] text-muted-foreground'>{s.client}</div>
            </td>
            <td className='px-3'>
              {s.routingMode === 'routed' ? (
                <Pill tone='ok' title={t('overview.modeRoutedHint')}>
                  {t('routing.common.modeRouted')}
                </Pill>
              ) : (
                <Pill tone='mute' title={t('overview.modePassthroughHint')}>
                  {t('routing.common.modePassthrough')}
                </Pill>
              )}
            </td>
            <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtCount(s.requests)}</td>
            <td className='px-3 text-right font-mono text-xs tabular-nums text-muted-foreground'>
              {fmtLatency(s.p50Ms)}
            </td>
            <td className='py-2.5 pl-3 pr-6 text-right font-mono text-xs tabular-nums text-muted-foreground'>
              {fmtRate(s.errorRate)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * The eight most recent sessions — deliberately not sortable. The server
 * already truncated to the newest eight, so a "most expensive" header
 * here would rank that slice while reading as an answer about every
 * session. That question belongs to Activity → Sessions, which holds the
 * whole list. The surface table above is likewise fixed: one row per
 * registered inbound surface, in registry order.
 */
function SessionTable({ data, now }: { data: OverviewResponse; now: number }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  if (data.recentSessions.length === 0) {
    return <div className='px-6 pb-6 text-xs text-muted-foreground'>{t('overview.noSessions')}</div>
  }
  return (
    <table className='w-full table-fixed'>
      <colgroup>
        <col className='w-40' />
        <col className='w-40' />
        <col />
        <col className='w-16' />
        <col className='w-20' />
        <col className='w-24' />
        <col className='w-16' />
      </colgroup>
      <thead>
        <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2'>
          <th className='pl-6 pr-3 text-left font-medium'>{t('activity.sessions.colSession')}</th>
          <th className='px-3 text-left font-medium'>{t('activity.sessions.colEndpoint')}</th>
          <th className='px-3 text-left font-medium'>{t('activity.sessions.colModel')}</th>
          <th className='px-3 text-right font-medium'>{t('activity.sessions.colTurns')}</th>
          <th className='px-3 text-right font-medium'>{t('activity.sessions.statTokens')}</th>
          <th className='px-3 text-right font-medium'>{t('activity.sessions.colCost')}</th>
          <th className='pl-3 pr-6 text-right font-medium'>{t('activity.sessions.colLast')}</th>
        </tr>
      </thead>
      <tbody>
        {data.recentSessions.map((s) => {
          const path = data.surfaces.find((x) => x.id === s.surface)?.path
          return (
            <tr
              key={s.sessionId}
              className={cn('border-t border-border/60', ROW_LINK)}
              onClick={() => navigate(`/activity/sessions/${s.sessionId}`)}
            >
              <td className='py-2.5 pl-6 pr-3 font-mono text-xs'>
                <Link to={`/activity/sessions/${s.sessionId}`} className='hover:underline'>
                  {shortId(s.sessionId)}
                </Link>
              </td>
              <td className='px-3'>
                {path === undefined ? <Mono>{t('activity.requests.laneUntracked')}</Mono> : <SurfacePill path={path} />}
              </td>
              <td className='px-3 font-mono text-xs text-muted-foreground'>{s.model}</td>
              <td className='px-3 text-right font-mono text-xs tabular-nums'>{s.turns}</td>
              <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtTokens(s.tokens)}</td>
              <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtCost(s.costUsd)}</td>
              <td className='py-2.5 pl-3 pr-6 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
                {fmtAgo(s.lastAt, now)}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export function Overview() {
  const { t } = useTranslation()
  const [data, setData] = useState<OverviewResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Captured once per load so every relative label on the page is
  // measured from the same instant the data describes.
  const [now, setNow] = useState(Date.now())
  const [windowHours, setWindowHours] = useState(24)
  const [rangeOpen, setRangeOpen] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    api
      .getOverview({ windowHours })
      .then((res) => {
        setData(res)
        setNow(Date.parse(res.generatedAt))
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [windowHours])

  useEffect(load, [load])

  const range = RANGES.find((r) => r.hours === windowHours)
  const rangeLabelKey = range === undefined ? 'activity.requests.range24h' : range.labelKey

  const subtitle =
    data === null
      ? undefined
      : t('overview.subtitle', {
          surfaces: data.surfaces.length,
          providers: data.providerCount,
          models: data.enabledModelCount
        })

  return (
    <Screen
      subtitle={subtitle}
      actions={
        <>
          <Popover open={rangeOpen} onOpenChange={setRangeOpen}>
            <PopoverTrigger asChild>
              <RButton variant='outline' icon='ri-time-line'>
                {t(rangeLabelKey)}
              </RButton>
            </PopoverTrigger>
            <PopoverContent align='end' className='w-40 p-1'>
              {RANGES.map((r) => (
                <button
                  key={r.hours}
                  type='button'
                  onClick={() => {
                    setWindowHours(r.hours)
                    setRangeOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60',
                    r.hours === windowHours ? 'font-medium' : 'text-muted-foreground'
                  )}
                >
                  {t(r.labelKey)}
                </button>
              ))}
            </PopoverContent>
          </Popover>
          <RButton variant='ghost' icon='ri-refresh-line' onClick={load} disabled={loading}>
            {t('settings.advanced.refresh')}
          </RButton>
        </>
      }
    >
      {error !== null ? (
        <div className='px-6 py-6 text-xs text-destructive'>{error}</div>
      ) : data === null ? (
        <div className='px-6 py-6 text-xs text-muted-foreground'>{t('common.loading')}</div>
      ) : (
        <>
          <Section title={t('overview.spend')}>
            <div className='grid grid-cols-4 gap-px px-6 pb-6'>
              {data.spend.map((s) => (
                <Link
                  key={s.label}
                  to='/activity/usage'
                  className='border-l-2 border-l-border px-4 py-3 transition-colors hover:bg-muted/50 hover:border-l-foreground/30'
                >
                  <div className='text-[12px] uppercase tracking-wider text-muted-foreground'>
                    {t(SPEND_LABEL_KEYS[s.label])}
                  </div>
                  <div className='mt-1 flex items-baseline gap-2'>
                    <span className='font-mono text-xl tabular-nums'>{fmtCost(s.usd)}</span>
                    {s.deltaRatio === null ? null : (
                      // A bare "+126%" reads as a share of something. It is
                      // the move against the previous period of the same
                      // length, which only the tooltip can say in the space.
                      <Pill tone={deltaTone(s.deltaRatio)} title={t('overview.spendDeltaHint')}>
                        {fmtDelta(s.deltaRatio)}
                      </Pill>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </Section>

          <Section
            title={t('overview.inboundSurfaces')}
            meta={
              // "last 168h" is arithmetic, not a period anyone thinks in.
              data.windowHours >= 24 && data.windowHours % 24 === 0
                ? t('overview.lastDays', { days: data.windowHours / 24 })
                : t('overview.lastHours', { hours: data.windowHours })
            }
          >
            <SurfaceTable data={data} />
          </Section>

          {/* Stacked, not side by side. The two-column split was fine when
              a quota row was one line per account; an account now lists
              every window it has, so the left column wrapped while the
              right sat half empty. */}
          <Section title={t('overview.subscriptionQuota')} meta={t('overview.quotaMeta')}>
            {data.quota.length === 0 ? (
              <div className='px-6 pb-6 text-xs text-muted-foreground'>{t('overview.noQuota')}</div>
            ) : (
              data.quota.map((q) => <QuotaAccount key={q.subAccountId} row={q} now={now} />)
            )}
          </Section>

          <Section title={t('overview.failoverActivity')} meta={t('overview.failoverMeta')}>
            {data.failover.length === 0 ? (
              <div className='px-6 pb-6 text-xs text-muted-foreground'>{t('overview.noFailover')}</div>
            ) : (
              data.failover.map((f) => (
                <FailoverEntry key={`${f.kind}-${f.at}-${f.target}-${f.account}`} row={f} now={now} />
              ))
            )}
          </Section>

          <Section title={t('overview.recentSessions')}>
            <SessionTable data={data} now={now} />
          </Section>
          <div className='h-10' />
        </>
      )}
    </Screen>
  )
}
