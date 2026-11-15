/**
 * The per-surface deny list, and the ways it must NOT fire.
 *
 * The point of the feature is that "may a caller name this here" and
 * "does the provider serve this at all" are different questions. The
 * second is `Model.enabled`, shared by every surface; this one is per
 * surface.
 */

import { describe, expect, test } from 'bun:test'
import { __setSurfacesForTests, passthroughDenial } from '../../src/services/inbound-surface-service'

const RESPONSES = '/v1/responses'
const TARGET = 'codex,gpt-5.5'

describe('passthroughDenial', () => {
  test('denies a listed target', async () => {
    __setSurfacesForTests({ 'openai-responses': [TARGET] })
    const denial = await passthroughDenial(RESPONSES, TARGET)
    expect(denial).toBeDefined()
    // The message names both halves: which target, and where it is off.
    expect(denial).toContain(TARGET)
    expect(denial).toContain(RESPONSES)
  })

  test('allows a target the list does not name', async () => {
    __setSurfacesForTests({ 'openai-responses': [TARGET] })
    expect(await passthroughDenial(RESPONSES, 'codex,gpt-5.4')).toBeUndefined()
  })

  test('an empty list allows everything — the behaviour before this existed', async () => {
    __setSurfacesForTests({})
    expect(await passthroughDenial(RESPONSES, TARGET)).toBeUndefined()
  })

  test('a path outside the surface registry is nobody’s business', async () => {
    __setSurfacesForTests({ 'openai-responses': [TARGET] })
    expect(await passthroughDenial('/nope', TARGET)).toBeUndefined()
  })

  test('an absent or empty target is not a denial', async () => {
    __setSurfacesForTests({ 'openai-responses': [TARGET] })
    expect(await passthroughDenial(RESPONSES, undefined)).toBeUndefined()
    expect(await passthroughDenial(RESPONSES, '')).toBeUndefined()
  })
})
