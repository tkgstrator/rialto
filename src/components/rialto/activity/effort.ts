/**
 * How the Activity tables order a reasoning effort.
 *
 * The cell prints the vendor's own spelling and never translates it, so
 * the only thing to decide here is the order.
 */
import type { SortValue } from '@/components/rialto/table-sort'
import { SupportedEffortSchema } from '@/schemas/domain/model-capability'

// Lowest first: none < minimal < low < medium < high < xhigh < max < ultra.
// Read off the schema rather than restated, so a level added there is
// ordered without a second edit.
const LADDER: readonly string[] = SupportedEffortSchema.options

/**
 * A rung on the effort ladder, for a column to sort on.
 *
 * Sorting the spellings alphabetically puts `high` before `low` and `max`
 * before `medium`, which reads as a bug the moment two levels sit in one
 * column. Null means unknown, and `useTableSort` keeps those rows last in
 * both directions: that covers a row that recorded no effort and a level
 * this build has not heard of, which has no rung to take. The log still
 * prints the latter as the vendor spelled it.
 */
export function effortSortValue(effort: string | null): SortValue {
  if (effort === null) return null
  const rung = LADDER.indexOf(effort)
  return rung === -1 ? null : rung
}
