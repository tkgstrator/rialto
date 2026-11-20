/**
 * The Requests table and its column menu share one descriptor list.
 *
 * A column added in request-columns shows up in the table and menu together.
 */

import { cn } from 'cn'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { COLUMNS, type ColumnDef, type ColumnId } from '@/components/rialto/activity/request-columns'
import type { Row } from '@/components/rialto/activity/requests-rows'
import { SortTh, type SortValue, useTableSort } from '@/components/rialto/table-sort'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

export type { ColumnDef, ColumnId } from '@/components/rialto/activity/request-columns'
export { COLUMNS } from '@/components/rialto/activity/request-columns'

// The floor under the auto column: what `provider,model` measures at its
// longest on this screen. Without it the table's minimum would count the
// one column that matters as zero and let it collapse.
const AUTO_MIN_WIDTH = 224

const BY_ID: ReadonlyMap<ColumnId, ColumnDef> = new Map(COLUMNS.map((col) => [col.id, col]))

// First and last columns carry the table's outer gutter, so their padding
// is derived from position rather than baked into the descriptor — hiding
// a column has to move the gutter with it.
//
// Only the horizontal gutter is positional. The header's bottom padding is a
// property of the row, not of its end cells, and lives on the `<tr>`: giving
// it to the edge cells alone lifted their labels by half that padding, so the
// first and last headers floated above the six between them.
const edgeClass = (index: number, count: number, cell: boolean): string => {
  const pad = cell ? 'py-2.5 ' : ''
  if (index === 0) return `${pad}pl-6 pr-2`
  if (index === count - 1) return `${pad}pl-2 pr-6`
  return 'px-2'
}

function RequestRow({ row, columns }: { row: Row; columns: readonly ColumnDef[] }) {
  const { t } = useTranslation()
  return (
    <tr className='border-t border-border/60'>
      {columns.map((col, i) => (
        <td
          key={col.id}
          className={cn(edgeClass(i, columns.length, true), col.align === 'right' ? 'text-right' : '', col.cellClass)}
        >
          {col.render(row, t)}
        </td>
      ))}
      <td className='py-2 pr-6 text-right'>
        <Button asChild variant='outline' size='icon-sm'>
          <Link
            aria-label={t('activity.requests.openSession')}
            to={`/activity/sessions/${encodeURIComponent(row.log.sessionId)}`}
          >
            <i aria-hidden className='ri-arrow-right-s-line text-base' />
          </Link>
        </Button>
      </td>
    </tr>
  )
}

export function RequestsTable({ rows, columns }: { rows: Row[]; columns: readonly ColumnDef[] }) {
  const { t } = useTranslation()
  // Resolved against COLUMNS rather than the visible subset so that hiding
  // the sorted column and showing it again restores the sort instead of
  // dropping it.
  const sortValue = useCallback(
    (row: Row, key: ColumnId): SortValue => {
      const col = BY_ID.get(key)
      return col === undefined || col.sortValue === undefined ? null : col.sortValue(row, t)
    },
    [t]
  )
  // While the column is hidden the sort does not apply: this is the one table
  // whose columns can go away, and rows left ordered by an off-screen column
  // have no caret and no header to click to undo them.
  const visibleKeys = useMemo(() => columns.map((col) => col.id), [columns])
  const sort = useTableSort<Row, ColumnId>(rows, sortValue, visibleKeys)
  // What the table refuses to go below. Twelve columns want 1440px and a
  // 1440px window has 1184 left after the sidebar, so the last columns
  // scroll rather than every column paying for the gap in ellipses. It is
  // summed from the visible columns, so hiding one through the Columns
  // menu takes its width out of the scroll as well as out of the row.
  const minWidth = useMemo(
    () => columns.reduce((sum, col) => sum + (col.width === 0 ? AUTO_MIN_WIDTH : col.width), 56),
    [columns]
  )
  return (
    <div className='overflow-x-auto'>
      <table className='w-full table-fixed' style={{ minWidth }}>
        <colgroup>
          {columns.map((col) => (
            <col key={col.id} style={col.width === 0 ? undefined : { width: col.width }} />
          ))}
          <col className='w-14' />
        </colgroup>
        <thead>
          <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2'>
            {columns.map((col, i) => {
              const className = cn(
                edgeClass(i, columns.length, false),
                col.align === 'right' ? 'text-right' : 'text-left',
                'font-medium'
              )
              return col.sortValue === undefined ? (
                <th key={col.id} className={className}>
                  {t(col.labelKey)}
                </th>
              ) : (
                <SortTh key={col.id} sortKey={col.id} sort={sort} className={className} align={col.align}>
                  {t(col.labelKey)}
                </SortTh>
              )
            })}
            <th>
              <span className='sr-only'>{t('activity.requests.openSession')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sort.sorted.map((row) => (
            <RequestRow key={row.log.id} row={row} columns={columns} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Header control that hides columns. Useful on a narrow window where the
 *  twelve-column log wraps into unreadability. */
export function ColumnMenu({ hidden, onChange }: { hidden: Set<ColumnId>; onChange: (next: Set<ColumnId>) => void }) {
  const { t } = useTranslation()
  const toggle = (id: ColumnId) => {
    const next = new Set(hidden)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next)
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant='outline' size='sm' type='button'>
          <i aria-hidden className='ri-layout-column-line text-sm leading-none' />
          {t('activity.requests.columnsMenu')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-48 gap-0 p-1'>
        {COLUMNS.map((col) => {
          const on = !hidden.has(col.id)
          return (
            <Button
              variant='ghost'
              size='sm'
              aria-pressed={on}
              key={col.id}
              type='button'
              onClick={() => toggle(col.id)}
              className={cn(
                'justify-start gap-2 rounded px-2 text-left text-xs',
                on ? 'font-medium' : 'text-muted-foreground'
              )}
            >
              <i aria-hidden className={cn('ri-check-line text-xs', on ? '' : 'opacity-0')} />
              {t(col.labelKey)}
            </Button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
