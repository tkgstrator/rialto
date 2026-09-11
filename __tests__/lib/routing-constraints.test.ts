/**
 * The Routing screen's constraint cells: how a stored blob reads, how an
 * edit lands on it, and when the pair counts as changed.
 */

import { describe, expect, test } from 'bun:test'
import {
  applyConstraintEdit,
  constraintsDiffer,
  exhaustedBehaviorOf,
  parseQuotaSkipPct,
  quotaSkipPctOf,
  type TierSubstitution,
  tierSubstitutionOf
} from '../../src/components/rialto/routing/derive'

describe('reading a blob', () => {
  test('a profile that never stored constraints reads as the schema defaults', () => {
    expect(tierSubstitutionOf(null)).toBe('upDown')
    expect(exhaustedBehaviorOf(null)).toBe('429')
    expect(quotaSkipPctOf(null)).toBe(100)
  })

  test('each pair of tier gates reads as one of the four answers', () => {
    expect(tierSubstitutionOf({ allowEscalation: true, allowDemotion: false })).toBe('up')
    expect(tierSubstitutionOf({ allowEscalation: false, allowDemotion: true })).toBe('down')
    expect(tierSubstitutionOf({ allowEscalation: false, allowDemotion: false })).toBe('same')
    // One gate stored, the other absent: the absent one is its default.
    expect(tierSubstitutionOf({ allowEscalation: false })).toBe('down')
  })
})

describe('applying an edit', () => {
  test('every substitution writes the gates that read back as it', () => {
    const all: TierSubstitution[] = ['upDown', 'up', 'down', 'same']
    for (const value of all) {
      expect(tierSubstitutionOf(applyConstraintEdit(null, { kind: 'tierSubstitution', value }))).toBe(value)
    }
  })

  test('keys the screen does not show survive the edit', () => {
    const edited = applyConstraintEdit(
      { longContextThreshold: 90_000, allowEscalation: false },
      { kind: 'quotaSkipPct', value: 80 }
    )
    expect(edited).toEqual({ longContextThreshold: 90_000, allowEscalation: false, quotaSkipPct: 80 })
  })

  test('a null blob becomes an object holding only the edited key', () => {
    expect(applyConstraintEdit(null, { kind: 'exhaustedBehavior', value: 'passthrough' })).toEqual({
      exhaustedBehavior: 'passthrough'
    })
  })
})

describe('constraintsDiffer', () => {
  test('writing the defaults a null blob already meant is not a change', () => {
    expect(constraintsDiffer(null, { allowEscalation: true, allowDemotion: true, quotaSkipPct: 100 })).toBe(false)
  })

  test('any cell that reads differently is a change', () => {
    expect(constraintsDiffer(null, { quotaSkipPct: 90 })).toBe(true)
    expect(constraintsDiffer(null, { exhaustedBehavior: 'passthrough' })).toBe(true)
    expect(constraintsDiffer({ allowDemotion: false }, null)).toBe(true)
  })
})

describe('parseQuotaSkipPct', () => {
  test('accepts a whole percentage from 0 to 100', () => {
    expect(parseQuotaSkipPct('0')).toBe(0)
    expect(parseQuotaSkipPct('100')).toBe(100)
    expect(parseQuotaSkipPct(' 42 ')).toBe(42)
  })

  test('refuses anything else', () => {
    for (const text of ['', '101', '5.5', '-1', 'abc', '1000']) {
      expect(parseQuotaSkipPct(text)).toBeNull()
    }
  })
})
