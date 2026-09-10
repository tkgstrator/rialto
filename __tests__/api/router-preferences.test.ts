/**
 * `constraints.longContextThreshold` on `/api/router-preferences`.
 *
 * The manual longContext threshold used to live on a RouterSlot; it is a
 * profile constraint now, so the Routing screen edits it where the rest
 * of the chain's knobs are and the migration carried the old value there.
 * Null means "auto" — the classifier derives the threshold from the
 * chain's own default model.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { routerPreferencesRoute } from '../../src/api/router-preferences/route'
import { QuotaAwareConstraintsSchema } from '../../src/schemas/domain/preference'
import { HAS_DB, resetDbTables, teardownPrisma } from '../db/helpers'
import { profileWith } from '../llms/chain-fixture'

// The parsed threshold, or undefined when the blob fails the schema —
// so a test can assert on either outcome without a throw in between.
const thresholdOf = (constraints: unknown): number | null | undefined => {
  const result = QuotaAwareConstraintsSchema.safeParse(constraints)
  return result.success ? result.data.longContextThreshold : undefined
}

describe('the constraint schema', () => {
  test('defaults to auto (null)', () => {
    expect(thresholdOf({})).toBeNull()
  })

  test('accepts a positive integer and nothing else', () => {
    expect(thresholdOf({ longContextThreshold: 90_000 })).toBe(90_000)
    expect(thresholdOf({ longContextThreshold: 0 })).toBeUndefined()
    expect(thresholdOf({ longContextThreshold: 1.5 })).toBeUndefined()
  })
})

describe.skipIf(!HAS_DB)('GET/PUT /api/router-preferences — longContextThreshold', () => {
  beforeEach(async () => {
    await resetDbTables()
  })

  afterAll(async () => {
    await teardownPrisma()
  })

  const put = (constraints: Record<string, unknown> | null): Promise<Response> =>
    routerPreferencesRoute.fetch(
      new Request('http://local/api/router-preferences', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(profileWith({}, constraints))
      })
    )

  const get = async (): Promise<{ constraints: Record<string, unknown> | null }> => {
    const res = await routerPreferencesRoute.fetch(new Request('http://local/api/router-preferences'))
    expect(res.status).toBe(200)
    const body: { constraints: Record<string, unknown> | null } = await res.json()
    return body
  }

  test('a pinned threshold round-trips', async () => {
    const res = await put({ longContextThreshold: 90_000 })
    expect(res.status).toBe(200)
    const body = await get()
    expect(body.constraints?.longContextThreshold).toBe(90_000)
    // …and parses to the same value the classifier reads.
    expect(thresholdOf(body.constraints)).toBe(90_000)
  })

  test('clearing it back to auto round-trips as null', async () => {
    await put({ longContextThreshold: 90_000 })
    await put({ longContextThreshold: null })
    const body = await get()
    expect(body.constraints?.longContextThreshold).toBeNull()
  })
})
