/**
 * Unit tests for ConfigEnvelopeSchema — focused on the API_TIMEOUT_MS field
 * that was historically written to disk as a string by the UI forms.
 *
 * Key invariant: z.coerce.number() must accept string inputs so that existing
 * config files produced by the old UI do not fail validation and get deleted
 * on next startup.
 */

import { describe, expect, test } from 'bun:test'
import { ConfigEnvelopeSchema } from '../../src/schemas/domain/config'

const BASE = { LOG_LEVEL: 'info' } as const

describe('ConfigEnvelopeSchema — API_TIMEOUT_MS', () => {
  test('accepts a numeric value', () => {
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE, API_TIMEOUT_MS: 60000 })
    expect(result.success).toBe(true)
    expect(result.data?.API_TIMEOUT_MS).toBe(60000)
  })

  test('coerces a numeric string to number', () => {
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE, API_TIMEOUT_MS: '60000' })
    expect(result.success).toBe(true)
    expect(result.data?.API_TIMEOUT_MS).toBe(60000)
  })

  test('coerces "600000" (old UI default) to 600000', () => {
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE, API_TIMEOUT_MS: '600000' })
    expect(result.success).toBe(true)
    expect(result.data?.API_TIMEOUT_MS).toBe(600000)
  })

  test('accepts zero (minimum nonnegative)', () => {
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE, API_TIMEOUT_MS: 0 })
    expect(result.success).toBe(true)
    expect(result.data?.API_TIMEOUT_MS).toBe(0)
  })

  test('accepts zero as string', () => {
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE, API_TIMEOUT_MS: '0' })
    expect(result.success).toBe(true)
    expect(result.data?.API_TIMEOUT_MS).toBe(0)
  })

  test('rejects negative integer', () => {
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE, API_TIMEOUT_MS: -1 })
    expect(result.success).toBe(false)
  })

  test('rejects negative string', () => {
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE, API_TIMEOUT_MS: '-1' })
    expect(result.success).toBe(false)
  })

  test('rejects float', () => {
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE, API_TIMEOUT_MS: 1.5 })
    expect(result.success).toBe(false)
  })

  test('rejects float string', () => {
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE, API_TIMEOUT_MS: '1.5' })
    expect(result.success).toBe(false)
  })

  test('rejects non-numeric string', () => {
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE, API_TIMEOUT_MS: 'fast' })
    expect(result.success).toBe(false)
  })

  test('is optional — absent key is valid', () => {
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE })
    expect(result.success).toBe(true)
    expect(result.data?.API_TIMEOUT_MS).toBeUndefined()
  })

  test('is optional — undefined value is valid', () => {
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE, API_TIMEOUT_MS: undefined })
    expect(result.success).toBe(true)
    expect(result.data?.API_TIMEOUT_MS).toBeUndefined()
  })
})

// APIKEY is no longer a declared key: /api/* admits a browser on the host
// or a Cloudflare Access assertion, and nothing else. A copy left on disk
// by an older build must not take the whole config down with it.
describe('ConfigEnvelopeSchema — a leftover APIKEY', () => {
  test('is not declared, so a config without one gets no default', () => {
    const result = ConfigEnvelopeSchema.safeParse({})
    expect(result.success).toBe(true)
    expect(result.data !== undefined && 'APIKEY' in result.data).toBe(false)
  })

  test('still parses when one is on disk, through the catchall', () => {
    const result = ConfigEnvelopeSchema.safeParse({ APIKEY: 'abc' })
    expect(result.success).toBe(true)
  })
})

describe('ConfigEnvelopeSchema — PORT', () => {
  test('accepts valid port number', () => {
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE, PORT: 3456 })
    expect(result.success).toBe(true)
    expect(result.data?.PORT).toBe(3456)
  })

  test('rejects port zero', () => {
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE, PORT: 0 })
    expect(result.success).toBe(false)
  })

  test('rejects negative port', () => {
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE, PORT: -1 })
    expect(result.success).toBe(false)
  })
})

describe('ConfigEnvelopeSchema — LOG_LEVEL', () => {
  const VALID_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const

  for (const level of VALID_LEVELS) {
    test(`accepts "${level}"`, () => {
      const result = ConfigEnvelopeSchema.safeParse({ ...BASE, LOG_LEVEL: level })
      expect(result.success).toBe(true)
    })
  }

  test('rejects unknown log level', () => {
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE, LOG_LEVEL: 'verbose' })
    expect(result.success).toBe(false)
  })
})

describe('ConfigEnvelopeSchema — catchall', () => {
  test('passes through unknown keys, including a retired one still on disk', () => {
    // `Router` is no longer declared; a copy left on disk by an older
    // build survives the parse (and is read by nothing) rather than
    // taking the whole config down.
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE, Providers: [], Router: {} })
    expect(result.success).toBe(true)
  })
})

// ActivePersona is the active persona's id: a top-level key on the wire
// and the same top-level optional scalar in the envelope.
describe('ConfigEnvelopeSchema — Personas / ActivePersona', () => {
  test('defaults Personas to [] when absent', () => {
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE })
    expect(result.success).toBe(true)
    expect(result.data?.Personas).toEqual([])
  })

  test('accepts a persona library', () => {
    const result = ConfigEnvelopeSchema.safeParse({
      ...BASE,
      Personas: [{ name: 'pirate', prompt: 'Talk like a pirate.' }]
    })
    expect(result.success).toBe(true)
    expect(result.data?.Personas).toEqual([{ name: 'pirate', prompt: 'Talk like a pirate.' }])
  })

  test('rejects a persona with an empty name', () => {
    const result = ConfigEnvelopeSchema.safeParse({
      ...BASE,
      Personas: [{ name: '', prompt: 'x' }]
    })
    expect(result.success).toBe(false)
  })

  test('allows an empty persona prompt', () => {
    const result = ConfigEnvelopeSchema.safeParse({
      ...BASE,
      Personas: [{ name: 'draft', prompt: '' }]
    })
    expect(result.success).toBe(true)
  })

  test('ActivePersona is optional', () => {
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE })
    expect(result.success).toBe(true)
    expect(result.data?.ActivePersona).toBeUndefined()
  })

  test('accepts an ActivePersona name', () => {
    const result = ConfigEnvelopeSchema.safeParse({ ...BASE, ActivePersona: 'pirate' })
    expect(result.success).toBe(true)
    expect(result.data?.ActivePersona).toBe('pirate')
  })
})
