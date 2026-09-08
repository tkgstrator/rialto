/**
 * The Sessions table.
 *
 * Ten columns whose widths are declared once in the colgroup and never
 * again — the row builds cells in the same order and relies on it. That
 * coupling is the reason the two components sit in one file and the
 * screen sees neither.
 */
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import type { Enriched } from '@/components/rialto/activity/sessions-derive'
import { SurfaceCell } from '@/components/rialto/activity/shared'
import { SortTh, type SortValue, useTableSort } from '@/components/rialto/table-sort'
import type { SessionSummary } from '@/lib/api'
import { fmtAgo, shortId } from '@/lib/rialto/format'
import { fmtCost, fmtTokens } from '@/lib/sessions/format'

// What the first cell prints as its heading line. Shared with the sort so
// the column cannot order by the preview while the row shows something
// else.
//
// The raw session id used to sit under it on every row. It is a 36-char
// uuid that identifies the row to the API, not to a person — two of them
// differ somewhere in the middle and the eye cannot tell them apart — so
// the row now shows only what an operator recognises: the opening turn.
// The id stays in the row's link and on the detail screen, which is where
// it gets copied. A session whose first turn was never captured falls
// back to a short form of the id, because a row still has to be nameable.
const titleOf = (session: SessionSummary): string =>
  session.preview === null || session.preview === '' ? shortId(session.sessionId) : session.preview

// Trend and Last are gone. The sparkline was a shape nobody could order
// or read a number off — seven points at 40px wide, in a table whose
// other nine columns are exact figures — and the age column repeated
// what the default ordering already says, since the list arrives newest
// first. Both are still on the session's own screen, where there is room
// to mean something.
type SessionSortKey = 'session' | 'endpoint' | 'model' | 'turns' | 'input' | 'output' | 'cache' | 'cost'

const sessionSortValue = (row: Enriched, key: SessionSortKey): SortValue => {
  const { session } = row
  if (key === 'session') return titleOf(session)
  if (key === 'endpoint') return row.surfacePath
  if (key === 'model') return row.model
  if (key === 'turns') return session.requestCount
  if (key === 'input') return session.totalInputTokens
  if (key === 'output') return session.totalOutputTokens
  if (key === 'cache') return cacheHitPct(session)
  return session.totalCostUsd
}

/**
 * Share of this session's input tokens that came from cache.
 *
 * Token-weighted, matching the session detail. The server also ships
 * `avgCacheHitPct`, an unweighted mean of the per-request percentages —
 * that let a handful of tiny calls outvote the large ones, so the same
 * session read 45% in this table and 65% on its own page, with nothing
 * saying which was wrong.
 */
const cacheHitPct = (session: SessionSummary): number =>
  session.totalInputTokens === 0 ? 0 : Math.round((session.totalCacheReadTokens / session.totalInputTokens) * 100)

function SessionRow({ row }: { row: Enriched }) {
  const { t } = useTranslation()
  const { session } = row
  const title = titleOf(session)
  return (
    <tr className='border-t border-border/60 transition-colors hover:bg-muted/50'>
      <td className='py-3 pl-6 pr-3'>
        <Link to={`/activity/sessions/${encodeURIComponent(session.sessionId)}`} className='block'>
          <div className='truncate text-xs font-medium'>{title}</div>
        </Link>
      </td>
      <td className='px-3'>
        <SurfaceCell path={row.surfacePath} />
      </td>
      <td className='truncate px-3 font-mono text-[12px] text-muted-foreground'>{row.model}</td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{session.requestCount}</td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtTokens(session.totalInputTokens)}</td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtTokens(session.totalOutputTokens)}</td>
      <td className='px-3 text-right font-mono text-xs tabular-nums text-muted-foreground'>{cacheHitPct(session)}%</td>
      <td className='py-3 pl-3 pr-6 text-right font-mono text-xs tabular-nums'>{fmtCost(session.totalCostUsd)}</td>
    </tr>
  )
}

export function SessionsTable({ rows }: { rows: Enriched[] }) {
  const { t } = useTranslation()
  const sortValue = useCallback((row: Enriched, key: SessionSortKey): SortValue => sessionSortValue(row, key), [])
  const sort = useTableSort<Enriched, SessionSortKey>(rows, sortValue)
  return (
    <table className='w-full table-fixed'>
      <colgroup>
        <col />
        <col className='w-40' />
        <col className='w-36' />
        <col className='w-16' />
        <col className='w-20' />
        <col className='w-20' />
        <col className='w-16' />
        <col className='w-24' />
      </colgroup>
      <thead>
        <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2'>
          <SortTh sortKey='session' sort={sort} className='pl-6 pr-3 text-left font-medium'>
            {t('activity.sessions.colSession')}
          </SortTh>
          <SortTh sortKey='endpoint' sort={sort} className='px-3 text-left font-medium'>
            {t('activity.sessions.colEndpoint')}
          </SortTh>
          <SortTh sortKey='model' sort={sort} className='px-3 text-left font-medium'>
            {t('activity.sessions.colModel')}
          </SortTh>
          <SortTh sortKey='turns' sort={sort} className='px-3 text-right font-medium' align='right'>
            {t('activity.sessions.colTurns')}
          </SortTh>
          <SortTh sortKey='input' sort={sort} className='px-3 text-right font-medium' align='right'>
            {t('activity.sessions.colInput')}
          </SortTh>
          <SortTh sortKey='output' sort={sort} className='px-3 text-right font-medium' align='right'>
            {t('activity.sessions.colOutput')}
          </SortTh>
          <SortTh sortKey='cache' sort={sort} className='px-3 text-right font-medium' align='right'>
            {t('activity.sessions.colCache')}
          </SortTh>
          <SortTh sortKey='cost' sort={sort} className='pl-3 pr-6 text-right font-medium' align='right'>
            {t('activity.sessions.colCost')}
          </SortTh>
        </tr>
      </thead>
      <tbody>
        {sort.sorted.map((row) => (
          <SessionRow key={row.session.sessionId} row={row} />
        ))}
      </tbody>
    </table>
  )
}
