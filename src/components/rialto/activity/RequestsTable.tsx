/**
 * The Requests table: its column descriptors and the two components that
 * consume them.
 *
 * `ColumnMenu` lives here rather than with the screen's other header
 * controls because it is the one control whose entire content IS
 * `COLUMNS` — putting it on the far side of this boundary would mean
 * exporting the descriptor list purely so a popover could enumerate it.
 * A column added below shows up in the table and in the menu together.
 */
import type { TFunction } from 'i18next'
import { type ReactNode, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { LANE_KEYS, type Row } from '@/components/rialto/activity/requests-rows'
import { DASH, StatusPill, SurfaceCell } from '@/components/rialto/activity/shared'
import { Pill } from '@/components/rialto/primitives'
import { SortTh, type SortValue, useTableSort } from '@/components/rialto/table-sort'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import dayjs from '@/lib/dayjs'
import { fmtCost, fmtTokens } from '@/lib/sessions/format'
import { cn } from '@/lib/utils'

export type ColumnId =
  | 'time'
  | 'status'
  | 'endpoint'
  | 'models'
  | 'rule'
  | 'lane'
  | 'token'
  | 'input'
  | 'output'
  | 'ms'
  | 'cost'

export interface ColumnDef {
  id: ColumnId
  /** Translation key for the header; the table and the menu resolve it. */
  labelKey: string
  /** colgroup width class; empty means "take the remaining space". */
  width: string
  align: 'left' | 'right'
  cellClass: string
  /** `t` is threaded through because the descriptors are module-level. */
  render: (row: Row, t: TFunction) => ReactNode
  /**
   * What the header orders on. Omitted by a column that is not worth
   * reading down — that column keeps a plain `<th>`, so "sortable" is a
   * property of the descriptor rather than a list the header maintains
   * separately and forgets to update.
   *
   * It takes `t` for the same reason `render` does: a cell that shows a
   * translated label has to sort by that label, or a Japanese UI orders
   * its rows by the English spelling nobody can see.
   */
  sortValue?: (row: Row, t: TFunction) => SortValue
}

const tokens = (n: number): string => (n === 0 ? DASH : fmtTokens(n))

// The renderers above print a dash for 0 — the log recorded no count,
// which is not the same claim as "zero tokens" — so the sort has to call
// it missing too. Left as a number it would open every ascending sort
// with a block of dashes.
const absentWhenZero = (n: number): SortValue => (n === 0 ? null : n)

const instant = (iso: string): SortValue => {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

function ModelsCell({ row }: { row: Row }) {
  const { t } = useTranslation()
  const requested = row.log.requestedModel
  const requestedLabel = requested === null ? t('activity.common.untracked') : requested
  const sent = `${row.log.provider},${row.log.model}`
  // Two model ids in one column truncate to "claude… → claude-code…" at
  // any realistic width, which makes the one column an operator opens this
  // screen for unreadable. The full pair goes in the tooltip so the answer
  // is a hover away rather than a horizontal scroll.
  return (
    <div className='flex items-center gap-1.5 font-mono text-[12px]' title={`${requestedLabel} → ${sent}`}>
      <span className='truncate text-muted-foreground'>{requestedLabel}</span>
      <i className='ri-arrow-right-line shrink-0 text-xs text-muted-foreground/50' />
      <span className='truncate'>{sent}</span>
    </div>
  )
}

export const COLUMNS: readonly ColumnDef[] = [
  {
    id: 'time',
    labelKey: 'activity.requests.colTime',
    width: 'w-20',
    align: 'left',
    cellClass: 'font-mono text-[12px] tabular-nums text-muted-foreground',
    render: (row) => dayjs(row.log.createdAt).format('HH:mm:ss'),
    // The cell abbreviates the arrival instant to a clock, but the column
    // means the instant: over a 7d window, ordering the printed HH:mm:ss
    // would interleave the days.
    sortValue: (row) => instant(row.log.createdAt)
  },
  {
    id: 'status',
    labelKey: 'activity.requests.colStatus',
    width: 'w-16',
    align: 'left',
    cellClass: '',
    render: (row) => <StatusPill status={row.log.status} />,
    sortValue: (row) => row.log.status
  },
  {
    id: 'endpoint',
    labelKey: 'activity.requests.colEndpoint',
    width: 'w-40',
    align: 'left',
    cellClass: '',
    render: (row) => <SurfaceCell path={row.surfacePath} />,
    // Null is the surface the row never recorded, so those land at the
    // bottom either way rather than sorting under their "untracked" label.
    sortValue: (row) => row.surfacePath
  },
  {
    id: 'models',
    labelKey: 'activity.requests.colModels',
    width: '',
    align: 'left',
    cellClass: '',
    render: (row) => <ModelsCell row={row} />,
    // The cell holds two identifiers; this orders by the sent pair — the
    // emphasized half, and the only way to group the log by the upstream
    // that served it, since this screen has no model filter.
    sortValue: (row) => `${row.log.provider},${row.log.model}`
  },
  {
    id: 'rule',
    labelKey: 'activity.requests.colRule',
    width: 'w-32',
    align: 'left',
    cellClass: 'text-[12px]',
    render: (row) =>
      row.rule === null ? <span className='text-muted-foreground/50'>{DASH}</span> : <span>{row.rule}</span>,
    sortValue: (row) => row.rule
  },
  {
    id: 'lane',
    labelKey: 'activity.requests.colLane',
    width: 'w-20',
    align: 'left',
    cellClass: '',
    render: (row, t) => <Pill tone='mute'>{t(LANE_KEYS[row.lane])}</Pill>,
    sortValue: (row, t) => t(LANE_KEYS[row.lane])
  },
  {
    id: 'token',
    labelKey: 'activity.requests.colToken',
    width: 'w-40',
    align: 'left',
    cellClass: 'truncate text-[12px] text-muted-foreground',
    render: (row, t) => (row.client === null ? t('activity.common.untracked') : row.client),
    sortValue: (row) => row.client
  },
  {
    id: 'input',
    labelKey: 'activity.requests.colInput',
    width: 'w-20',
    align: 'right',
    cellClass: 'font-mono text-xs tabular-nums',
    render: (row) => tokens(row.log.totalInputTokens),
    sortValue: (row) => absentWhenZero(row.log.totalInputTokens)
  },
  {
    id: 'output',
    labelKey: 'activity.requests.colOutput',
    width: 'w-20',
    align: 'right',
    cellClass: 'font-mono text-xs tabular-nums',
    render: (row) => tokens(row.log.outputTokens),
    sortValue: (row) => absentWhenZero(row.log.outputTokens)
  },
  {
    id: 'ms',
    labelKey: 'activity.requests.colMs',
    width: 'w-20',
    align: 'right',
    cellClass: 'font-mono text-xs tabular-nums text-muted-foreground',
    render: (row) => (row.log.durationMs === 0 ? DASH : row.log.durationMs.toLocaleString()),
    sortValue: (row) => absentWhenZero(row.log.durationMs)
  },
  {
    id: 'cost',
    labelKey: 'activity.requests.colCost',
    width: 'w-24',
    align: 'right',
    cellClass: 'font-mono text-xs tabular-nums',
    // A priced 0 prints as `$0` rather than as a dash, so unlike the token
    // columns it stays a number here; only an unpriced row is missing.
    render: (row) => fmtCost(row.log.totalCostUsd),
    sortValue: (row) => row.log.totalCostUsd
  }
]

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
    <tr className='border-t border-border/60 transition-colors hover:bg-muted/50'>
      {columns.map((col, i) => (
        <td
          key={col.id}
          className={cn(edgeClass(i, columns.length, true), col.align === 'right' ? 'text-right' : '', col.cellClass)}
        >
          {col.render(row, t)}
        </td>
      ))}
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
  return (
    <table className='w-full table-fixed'>
      <colgroup>
        {columns.map((col) => (
          <col key={col.id} className={col.width} />
        ))}
      </colgroup>
      <thead>
        <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:pb-2'>
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
        </tr>
      </thead>
      <tbody>
        {sort.sorted.map((row) => (
          <RequestRow key={row.log.id} row={row} columns={columns} />
        ))}
      </tbody>
    </table>
  )
}

/** Header control that hides columns. Useful on a narrow window where the
 *  eleven-column log wraps into unreadability. */
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
      <PopoverTrigger className='inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground'>
        <i className='ri-layout-column-line text-sm leading-none' />
        {t('activity.requests.columnsMenu')}
      </PopoverTrigger>
      <PopoverContent align='end' className='w-48 gap-0 p-1'>
        {COLUMNS.map((col) => {
          const on = !hidden.has(col.id)
          return (
            <button
              key={col.id}
              type='button'
              onClick={() => toggle(col.id)}
              className={cn(
                'flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60',
                on ? 'font-medium' : 'text-muted-foreground'
              )}
            >
              <i className={cn('ri-check-line text-xs', on ? '' : 'opacity-0')} />
              {t(col.labelKey)}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
