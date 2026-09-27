/** Column definitions shared by the request table and its menu. */
import { cn } from 'cn'
import type { TFunction } from 'i18next'
import type { ReactNode } from 'react'
import { LANE_KEYS, type Row } from '@/components/rialto/activity/requests-rows'
import { DASH, StatusPill, SurfaceCell } from '@/components/rialto/activity/shared'
import type { SortValue } from '@/components/rialto/table-sort'
import dayjs from '@/lib/dayjs'
import { fmtCost, fmtTokens } from '@/lib/sessions/format'

export type ColumnId =
  | 'time'
  | 'status'
  | 'endpoint'
  | 'requested'
  | 'sent'
  | 'rule'
  | 'token'
  | 'input'
  | 'output'
  | 'ms'
  | 'cost'

export interface ColumnDef {
  id: ColumnId
  /** Translation key for the header; the table and the menu resolve it. */
  labelKey: string
  /**
   * Column width in px; `0` is the auto column that takes what is left.
   *
   * A number rather than a Tailwind class because the table's own minimum
   * width is their sum: eleven columns need more than a 1440px window has
   * left over after the sidebar, so the table keeps its width and scrolls
   * instead of paying for the gap in ellipses. Hiding a column through the
   * Columns menu has to shrink that minimum with it, which a fixed class
   * on the table could not do.
   *
   * Each value is the widest thing the column actually renders plus its
   * padding, measured in the browser rather than guessed, and matches the
   * `w-*` class its column carries in `mocks/activity-requests.html`.
   */
  width: number
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

/**
 * One model identifier: the one the caller asked for, or the
 * `provider,model` that actually served the turn.
 *
 * They are two columns rather than one cell with an arrow between them.
 * Sharing a column meant both halves truncated to "claude… →
 * claude-code…" at 1440px — the pair needs 318px and the column had 272 —
 * which made the one thing this screen exists to show unreadable. The
 * title stays for the install whose identifiers are longer than the
 * measurements these widths came from.
 */
function ModelCell({ value, title, muted = false }: { value: string; title?: string; muted?: boolean }) {
  return (
    <span
      className={cn('block truncate font-mono text-[12px]', muted ? 'text-muted-foreground' : '')}
      title={title === undefined ? value : title}
    >
      {value}
    </span>
  )
}

/**
 * Arrival time, dated only when it needs to be.
 *
 * A bare HH:mm:ss is unambiguous while the range is an hour and useless
 * once it is seven days — two rows both reading 14:03:02 gave no way to
 * tell today from Tuesday. The date appears only when the row is not
 * from today, and the full local instant with its UTC offset lives in
 * the tooltip, because a time pasted into a thread with someone in
 * another timezone needs to carry one.
 */
function TimeCell({ iso }: { iso: string }) {
  const at = dayjs(iso)
  const sameDay = at.isSame(dayjs(), 'day')
  return <span title={at.format('YYYY-MM-DD HH:mm:ss Z')}>{at.format(sameDay ? 'HH:mm:ss' : 'MM-DD HH:mm')}</span>
}

export const COLUMNS: readonly ColumnDef[] = [
  {
    id: 'time',
    labelKey: 'activity.requests.colTime',
    // Wide enough for the dated form ("09-07 06:43") on one line; at 80
    // it wrapped and every row in a multi-day range grew a second line.
    width: 112,
    align: 'left',
    cellClass: 'whitespace-nowrap font-mono text-[12px] tabular-nums text-muted-foreground',
    render: (row) => <TimeCell iso={row.log.createdAt} />,
    // The cell abbreviates the arrival instant to a clock, but the column
    // means the instant: over a 7d window, ordering the printed HH:mm:ss
    // would interleave the days.
    sortValue: (row) => instant(row.log.createdAt)
  },
  {
    id: 'status',
    labelKey: 'activity.requests.colStatus',
    width: 64,
    align: 'left',
    cellClass: '',
    render: (row) => <StatusPill status={row.log.status} />,
    sortValue: (row) => row.log.status
  },
  {
    id: 'endpoint',
    labelKey: 'activity.requests.colEndpoint',
    width: 176,
    align: 'left',
    cellClass: '',
    render: (row) => <SurfaceCell path={row.surfacePath} />,
    // Null is the surface the row never recorded, so those land at the
    // bottom either way rather than sorting under their "untracked" label.
    sortValue: (row) => row.surfacePath
  },
  {
    id: 'requested',
    labelKey: 'activity.requests.colRequested',
    width: 144,
    align: 'left',
    cellClass: '',
    render: (row, t) => (
      <ModelCell
        muted
        value={row.log.requestedModel === null ? t('activity.common.untracked') : row.log.requestedModel}
      />
    ),
    // Muted, and sorting a row that recorded no model as missing rather
    // than under the spelling of its "untracked" label.
    sortValue: (row) => row.log.requestedModel
  },
  {
    id: 'sent',
    labelKey: 'activity.requests.colSent',
    // The auto column. A window wider than the table's minimum spends its
    // slack on the longest value on the screen rather than on gutters.
    width: 0,
    align: 'left',
    cellClass: '',
    // The model, not "provider,model". The pair truncated on any
    // realistic window and the half that got cut was the model — the one
    // thing this column exists to show. The provider is the hover, and it
    // still leads the sort, so the log can be grouped by the upstream
    // that served it on a screen with no model filter.
    render: (row) => <ModelCell value={row.log.model} title={`${row.log.provider},${row.log.model}`} />,
    sortValue: (row) => `${row.log.provider},${row.log.model}`
  },
  {
    // The lane rides with the rule rather than holding a column of its
    // own. It qualifies the routing decision (there is no lane without
    // one), it reads `agent` on almost every row, and the column it cost
    // belonged to the model pair — which was truncating both halves of
    // the one thing this screen exists to show.
    id: 'rule',
    labelKey: 'activity.requests.colRule',
    width: 144,
    align: 'left',
    cellClass: 'text-[12px]',
    render: (row, t) => (
      <span className='flex items-baseline gap-1.5'>
        {row.rule === null ? <span className='text-muted-foreground/50'>{DASH}</span> : <span>{row.rule}</span>}
        {row.lane === 'agent' ? null : <span className='text-muted-foreground'>· {t(LANE_KEYS[row.lane])}</span>}
      </span>
    ),
    sortValue: (row) => row.rule
  },
  {
    id: 'token',
    labelKey: 'activity.requests.colToken',
    width: 144,
    align: 'left',
    cellClass: 'truncate text-[12px] text-muted-foreground',
    render: (row, t) => (row.client === null ? t('activity.common.untracked') : row.client),
    sortValue: (row) => row.client
  },
  {
    id: 'input',
    labelKey: 'activity.requests.colInput',
    width: 80,
    align: 'right',
    cellClass: 'font-mono text-xs tabular-nums',
    render: (row) => tokens(row.log.totalInputTokens),
    sortValue: (row) => absentWhenZero(row.log.totalInputTokens)
  },
  {
    id: 'output',
    labelKey: 'activity.requests.colOutput',
    width: 80,
    align: 'right',
    cellClass: 'font-mono text-xs tabular-nums',
    render: (row) => tokens(row.log.outputTokens),
    sortValue: (row) => absentWhenZero(row.log.outputTokens)
  },
  {
    id: 'ms',
    labelKey: 'activity.requests.colMs',
    width: 80,
    align: 'right',
    cellClass: 'font-mono text-xs tabular-nums text-muted-foreground',
    render: (row) => (row.log.durationMs === 0 ? DASH : row.log.durationMs.toLocaleString()),
    sortValue: (row) => absentWhenZero(row.log.durationMs)
  },
  {
    id: 'cost',
    labelKey: 'activity.requests.colCost',
    width: 112,
    align: 'right',
    cellClass: 'font-mono text-xs tabular-nums',
    // A priced 0 prints as `$0` rather than as a dash, so unlike the token
    // columns it stays a number here; only an unpriced row is missing.
    render: (row) => fmtCost(row.log.totalCostUsd),
    sortValue: (row) => row.log.totalCostUsd
  }
]
