import { describe, expect, test } from 'bun:test'
import {
  type AccessTokenWire,
  countTokens,
  expiryToIso,
  sortTokens,
  tokenState
} from '../../../../src/lib/rialto/settings/access-tokens'

const NOW = Date.parse('2026-08-31T12:00:00.000Z')
const at = (offsetDays: number): string => new Date(NOW + offsetDays * 86_400_000).toISOString()

const token = (over: Partial<AccessTokenWire>): AccessTokenWire => ({
  id: 'tok_1',
  name: 'MacBook',
  prefix: 'rlt_a91f…',
  surfaces: [],
  profileKey: null,
  lastUsedAt: null,
  requestCount: 0,
  expiresAt: null,
  revokedAt: null,
  createdAt: at(-10),
  ...over
})

describe('tokenState', () => {
  test('an unexpired, unrevoked token is active', () => {
    expect(tokenState(token({}), NOW)).toBe('active')
    expect(tokenState(token({ expiresAt: at(1) }), NOW)).toBe('active')
  })

  test('a past expiry is dead even though nothing revoked it', () => {
    // resolveAccessToken rejects on expiry too, so rendering this as
    // active would show a credential that cannot actually authenticate.
    expect(tokenState(token({ expiresAt: at(-1) }), NOW)).toBe('expired')
  })

  test('expiry is exclusive at the boundary, matching the server test', () => {
    // Server accepts only while expiresAt > now.
    expect(tokenState(token({ expiresAt: new Date(NOW).toISOString() }), NOW)).toBe('expired')
  })

  test('revoked outranks expired so the row says why it is dead', () => {
    expect(tokenState(token({ revokedAt: at(-2), expiresAt: at(-1) }), NOW)).toBe('revoked')
  })
})

describe('countTokens', () => {
  test('counts each state separately', () => {
    const counts = countTokens(
      [
        token({ id: 'a' }),
        token({ id: 'b' }),
        token({ id: 'c', expiresAt: at(-1) }),
        token({ id: 'd', revokedAt: at(-3) })
      ],
      NOW
    )
    expect(counts).toEqual({ active: 2, expired: 1, revoked: 1 })
  })

  test('an empty list counts zero of everything', () => {
    expect(countTokens([], NOW)).toEqual({ active: 0, expired: 0, revoked: 0 })
  })
})

describe('sortTokens', () => {
  test('live credentials first, dead ones last', () => {
    const rows = sortTokens(
      [
        token({ id: 'revoked', revokedAt: at(-1) }),
        token({ id: 'expired', expiresAt: at(-1) }),
        token({ id: 'active' })
      ],
      NOW
    )
    expect(rows.map((r) => r.id)).toEqual(['active', 'expired', 'revoked'])
  })

  test('within a state, newest first', () => {
    const rows = sortTokens([token({ id: 'old', createdAt: at(-30) }), token({ id: 'new', createdAt: at(-1) })], NOW)
    expect(rows.map((r) => r.id)).toEqual(['new', 'old'])
  })

  test('does not mutate the caller’s array', () => {
    const input = [token({ id: 'revoked', revokedAt: at(-1) }), token({ id: 'active' })]
    sortTokens(input, NOW)
    expect(input.map((r) => r.id)).toEqual(['revoked', 'active'])
  })
})

describe('expiryToIso', () => {
  test('a bounded choice lands the requested number of days out', () => {
    expect(expiryToIso('30d', NOW)).toBe(new Date(NOW + 30 * 86_400_000).toISOString())
  })

  test('no-expiry and unknown ids both mean null rather than a bogus date', () => {
    expect(expiryToIso('never', NOW)).toBeNull()
    expect(expiryToIso('not-a-choice', NOW)).toBeNull()
  })
})
