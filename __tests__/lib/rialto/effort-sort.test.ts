/**
 * The order the Activity tables give a reasoning effort.
 *
 * Alphabetical order is wrong for it — `high` would sort before `low` and
 * `max` before `medium` — so the columns sort on a rung of the ladder the
 * capability schema already defines.
 */
import { describe, expect, test } from 'bun:test'
import { effortSortValue } from '../../../src/components/rialto/activity/effort'
import { SupportedEffortSchema } from '../../../src/schemas/domain/model-capability'

describe('effortSortValue', () => {
  test('climbs the ladder from none to ultra', () => {
    // Pins the schema's order as the ladder: a level inserted in the wrong
    // place there would silently reorder every effort column.
    const ladder = [...SupportedEffortSchema.options]
    expect(ladder).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(ladder.map(effortSortValue)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  test('orders by level, which the alphabet would not', () => {
    const shuffled = ['xhigh', 'low', 'max', 'high', 'medium']
    const byRung = [...shuffled].sort((a, b) => Number(effortSortValue(a)) - Number(effortSortValue(b)))
    expect(byRung).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect([...shuffled].sort()).not.toEqual(byRung)
  })

  test('a row that recorded no effort has no rung', () => {
    expect(effortSortValue(null)).toBeNull()
  })

  test('a level this build has not heard of has no rung either', () => {
    expect(effortSortValue('ludicrous')).toBeNull()
    expect(effortSortValue('')).toBeNull()
  })

  test('is case-sensitive, as the vendors spell the levels in lower case', () => {
    expect(effortSortValue('High')).toBeNull()
  })
})
