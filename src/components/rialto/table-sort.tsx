/**
 * Column sorting for the Rialto tables.
 *
 * Three decisions worth stating, because each one is a place a naive
 * implementation reads as a bug to the operator:
 *
 * 1. **Sorting cycles back to the unsorted order.** asc → desc → none.
 *    The natural order is not arbitrary — models come back in seed order,
 *    requests in arrival order — so "put it back" has to be reachable
 *    without a reload.
 * 2. **Missing values sort last in both directions.** A model with no
 *    published price is unknown, not cheap; floating it to the top of an
 *    ascending price sort would answer a question nobody asked.
 *
 *    Null here means *unknown*, and the caller decides which of its nulls
 *    that is. A token with no `expiresAt` is not missing an expiry — it is
 *    the furthest-out one there is — so `TokenTable` maps that case to
 *    `Number.POSITIVE_INFINITY` and lets it sort as the extreme it is. A
 *    null `lastUsedAt` on the same row genuinely is absent and stays null.
 *    Deciding this per column is why `valueFor` takes the key.
 * 3. **Ties keep the incoming order.** `Array.prototype.sort` is stable,
 *    so returning 0 for equal values preserves whatever the caller handed
 *    in. That is what makes sorting by a coarse column (tier, status)
 *    leave the rows inside each group alone.
 *
 * Not every table belongs here. `ChainTable` renders a preference chain
 * where the order *is* the configuration — offering to sort it would let
 * an operator scramble routing by clicking a header.
 */

import { useCallback, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'

export type SortDir = 'asc' | 'desc'

/** What a column sorts on. Null / undefined means "no value". */
export type SortValue = string | number | boolean | null | undefined

export interface TableSort<K extends string> {
  key: K | null
  dir: SortDir
  /** asc → desc → unsorted, per column. */
  toggle: (key: K) => void
}

const isMissing = (v: SortValue): boolean => v === null || v === undefined

/**
 * Compare two present values.
 *
 * Booleans compare false < true so an "enabled" column groups the off
 * rows together at one end rather than interleaving them. Missing values
 * never reach here — the sort callback settles those first, because they
 * must ignore the direction.
 */
const compare = (a: SortValue, b: SortValue): number => {
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b)
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) - Number(b)
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

export function useTableSort<T, K extends string>(
  rows: readonly T[],
  valueFor: (row: T, key: K) => SortValue,
  /**
   * Keys whose header is on screen right now. Optional — pass it only for
   * a table whose columns can be hidden.
   *
   * A sort whose column is not visible is a sort the operator cannot see
   * or undo: the rows stay reordered, the caret is nowhere, and nothing
   * on screen explains the order. Rather than expose a `clear()` for the
   * caller to remember to call, the sort simply does not apply while its
   * column is away, and resumes if the column comes back.
   */
  visibleKeys?: readonly K[]
): TableSort<K> & { sorted: T[] } {
  const [state, setState] = useState<{ key: K | null; dir: SortDir }>({ key: null, dir: 'asc' })

  const toggle = useCallback((key: K) => {
    setState((prev) => {
      if (prev.key !== key) return { key, dir: 'asc' }
      if (prev.dir === 'asc') return { key, dir: 'desc' }
      return { key: null, dir: 'asc' }
    })
  }, [])

  const activeKey =
    state.key !== null && (visibleKeys === undefined || visibleKeys.includes(state.key)) ? state.key : null

  const sorted = useMemo(() => {
    if (activeKey === null) return [...rows]
    const key = activeKey
    const sign = state.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = valueFor(a, key)
      const bv = valueFor(b, key)
      // Settled before the direction is applied: an unknown value belongs
      // at the bottom of an ascending sort AND a descending one.
      if (isMissing(av) && isMissing(bv)) return 0
      if (isMissing(av)) return 1
      if (isMissing(bv)) return -1
      return compare(av, bv) * sign
    })
  }, [rows, activeKey, state.dir, valueFor])

  // `key` reports the *effective* sort, so the caret and the row order
  // can never disagree.
  return { sorted, key: activeKey, dir: state.dir, toggle }
}

/**
 * A `<th>` that sorts. Renders a real button so the column is reachable
 * by keyboard, and carries `aria-sort` so a screen reader announces the
 * current state rather than just the label.
 */
export function SortTh<K extends string>({
  sortKey,
  sort,
  className,
  align = 'left',
  children
}: {
  sortKey: K
  sort: TableSort<K>
  className?: string
  align?: 'left' | 'right' | 'center'
  children: React.ReactNode
}) {
  const active = sort.key === sortKey
  const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
  const justify = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start'
  // The caret holds its space when inactive so the header row does not jog
  // sideways as the operator cycles through columns, and it sits on the
  // side away from the edge the column aligns to. Trailing it on a
  // right-aligned column pushed the label inward by the caret's width
  // while the cell below stayed flush, which reads as the header being
  // misaligned with its own column.
  const caret = (
    <i
      className={cn(
        'text-[11px]',
        active ? (sort.dir === 'asc' ? 'ri-arrow-up-s-fill' : 'ri-arrow-down-s-fill') : 'ri-arrow-up-s-fill opacity-0'
      )}
    />
  )
  return (
    <th className={className} aria-sort={ariaSort}>
      <button
        type='button'
        onClick={() => sort.toggle(sortKey)}
        className={cn(
          'inline-flex w-full items-center gap-1 font-medium uppercase tracking-wider transition-colors hover:text-foreground',
          justify,
          active ? 'text-foreground' : ''
        )}
      >
        {align === 'right' ? caret : null}
        {children}
        {align === 'right' ? null : caret}
      </button>
    </th>
  )
}
