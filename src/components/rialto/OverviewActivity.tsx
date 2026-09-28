import { cn } from 'cn'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { surfaceLabel } from '@/components/rialto/activity/use-surfaces'
import { Mono, Pill, SurfacePill } from '@/components/rialto/primitives'
import type { OverviewFailoverRow, OverviewResponse } from '@/lib/api'
import { fmtAgo, shortId } from '@/lib/rialto/format'
import { fmtCost, fmtTokens } from '@/lib/sessions/format'
import { ROW_LINK } from './overview-shared'

const failoverHref = (f: OverviewFailoverRow): string => (f.kind === 'rate_limit' ? '/activity/requests' : '/providers')

/**
 * One row of the failover feed: an account refused with a 429, or one
 * whose credential no longer authenticates.
 *
 * The two kinds share a layout but not a sentence, so each half picks its
 * own copy. Composing here rather than on the server is what lets a JA
 * install read this panel in Japanese. A 429 carries account, status and
 * Retry-After and nothing else: nothing records which target picked the
 * traffic up, so the row does not invent a destination.
 */
export function FailoverEntry({ row, now }: { row: OverviewFailoverRow; now: number }) {
  const { t } = useTranslation()
  const rateLimited = row.kind === 'rate_limit'

  const label = rateLimited ? (row.status === null ? '429' : String(row.status)) : t('overview.failoverAuthLabel')

  // Why, in words, on its own line. An auth row says what the upstream
  // said; it is its own sentence and is not ours to translate.
  const detail = rateLimited
    ? row.retryAfterSec === null
      ? t('overview.failoverNoRetryAfter')
      : t('overview.failoverRetryAfter', { secs: row.retryAfterSec })
    : row.error === null
      ? t('overview.failoverAuthRejected')
      : row.error

  return (
    <Link to={failoverHref(row)} className={cn('block border-t border-border/60 px-6 py-3', ROW_LINK)}>
      <div className='flex items-baseline gap-3'>
        <span className='w-14 shrink-0'>
          <Pill tone={row.tone}>{label}</Pill>
        </span>
        <span className='min-w-0 flex-1 truncate font-mono text-xs'>{row.account}</span>
        {/* A duration is a number: mono and tabular like every other
            figure here. In the proportional face "1h ago" and "46m ago"
            are different widths, so a column of them does not line up. */}
        <span className='w-16 shrink-0 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
          {row.at === '' ? '' : t('settings.access.lastUsedAgo', { ago: fmtAgo(row.at, now) })}
        </span>
      </div>
      <div className='mt-1 pl-[4.25rem] text-[12px] text-muted-foreground'>{detail}</div>
    </Link>
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
export function SessionTable({ data, now }: { data: OverviewResponse; now: number }) {
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
          // Through surfaceLabel rather than a bare find: `data.surfaces`
          // is the registry's rows, which never include /codex, and a
          // session Codex served over MCP would otherwise read untracked.
          const label = surfaceLabel(data.surfaces, s.surface)
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
                {label === undefined ? (
                  <Mono>{t('activity.requests.laneUntracked')}</Mono>
                ) : (
                  <SurfacePill path={label.path} />
                )}
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
