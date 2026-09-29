/**
 * The account rows' extras: their banked resets, indexed beside the
 * windows, and the two small formatters the account pages use.
 */

import { describe, expect, test } from 'bun:test'
import { fmtExpiry, indexAccountExtras } from '../../../src/components/rialto/providers/derive'
import { fmtValueRatio } from '../../../src/lib/rialto/format'

describe('indexAccountExtras', () => {
  test('keys each account by id, keeping a missing reset reading as null', () => {
    const index = indexAccountExtras([
      { subAccountId: 'a', resetCredits: null },
      { subAccountId: 'b', resetCredits: { available: 2, applicable: 0 } }
    ])
    expect(index.get('a')).toEqual({ resetCredits: null })
    expect(index.get('b')).toEqual({ resetCredits: { available: 2, applicable: 0 } })
  })
})

describe('fmtValueRatio', () => {
  test('one decimal under ten, whole numbers from ten, a dash when unknown', () => {
    expect(fmtValueRatio(1.64)).toBe('×1.6')
    expect(fmtValueRatio(11.3)).toBe('×11')
    expect(fmtValueRatio(null)).toBe('–')
  })
})

describe('fmtExpiry', () => {
  test("a date in the reader's language, a dash when there is none or it does not parse", () => {
    expect(fmtExpiry('2026-10-04T00:48:33.234766Z', 'en-US')).toBe('Oct 4')
    expect(fmtExpiry(null, 'en-US')).toBe('—')
    expect(fmtExpiry('not a date', 'en-US')).toBe('—')
  })
})
