/**
 * The account rows' extras: what an account carried and its banked resets,
 * indexed beside the windows, and the two small formatters they use.
 */

import { describe, expect, test } from 'bun:test'
import { fmtExpiry, indexAccountExtras } from '../../../src/components/rialto/providers/derive'
import { fmtValueRatio } from '../../../src/lib/rialto/format'

const figures = {
  requests: 1,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 2,
  costUsd: 1
}

describe('indexAccountExtras', () => {
  test('keys each account by id, keeping a missing usage or reset reading as null', () => {
    const index = indexAccountExtras([
      {
        subAccountId: 'a',
        usage: {
          windowStart: '2026-09-20T00:00:00.000Z',
          window: figures,
          last30d: figures,
          monthlyPriceUsd: 200,
          valueRatio: 0.005
        },
        resetCredits: null
      },
      { subAccountId: 'b', usage: null, resetCredits: { available: 2, applicable: 0 } }
    ])
    expect(index.get('a')?.usage?.monthlyPriceUsd).toBe(200)
    expect(index.get('a')?.resetCredits).toBeNull()
    expect(index.get('b')).toEqual({ usage: null, resetCredits: { available: 2, applicable: 0 } })
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
