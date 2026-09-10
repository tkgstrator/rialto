/**
 * The per-surface passthrough deny list, and the ways it must NOT fire.
 *
 * The point of the feature is that "may a caller name this here" and
 * "does the provider serve this at all" are different questions. The
 * second is `Model.enabled`, shared by every surface and every chain;
 * this one is per surface, and only has an answer in passthrough — in
 * routed mode `body.model` has already been replaced by the chain's
 * target, so judging it would reject a string that was never going to
 * reach an upstream.
 */

import { describe, expect, test } from 'bun:test'
import { __setSurfacesForTests, passthroughDenial } from '../../src/services/inbound-surface-service'

const RESPONSES = '/v1/responses'
const TARGET = 'codex,gpt-5.5'

describe('passthroughDenial', () => {
  test('denies a listed target on a passthrough surface', async () => {
    __setSurfacesForTests({ 'openai-responses': 'passthrough' }, { 'openai-responses': [TARGET] })
    const denial = await passthroughDenial(RESPONSES, TARGET)
    expect(denial).toBeDefined()
    // The message names both halves: which target, and where it is off.
    expect(denial).toContain(TARGET)
    expect(denial).toContain(RESPONSES)
  })

  test('allows a target the list does not name', async () => {
    __setSurfacesForTests({ 'openai-responses': 'passthrough' }, { 'openai-responses': [TARGET] })
    expect(await passthroughDenial(RESPONSES, 'codex,gpt-5.4')).toBeUndefined()
  })

  test('an empty list allows everything — the behaviour before this existed', async () => {
    __setSurfacesForTests({ 'openai-responses': 'passthrough' })
    expect(await passthroughDenial(RESPONSES, TARGET)).toBeUndefined()
  })

  // The same list on a routed surface is not a veto. The chain has
  // already rewritten body.model by the time the check runs, so the
  // string being judged is the chain's target, not the caller's ask.
  test('never denies on a routed surface, even with the target listed', async () => {
    __setSurfacesForTests({ 'openai-responses': 'routed' }, { 'openai-responses': [TARGET] })
    expect(await passthroughDenial(RESPONSES, TARGET)).toBeUndefined()
  })

  test('a path outside the surface registry is nobody’s business', async () => {
    __setSurfacesForTests({ 'openai-responses': 'passthrough' }, { 'openai-responses': [TARGET] })
    expect(await passthroughDenial('/nope', TARGET)).toBeUndefined()
  })

  test('an absent or empty target is not a denial', async () => {
    __setSurfacesForTests({ 'openai-responses': 'passthrough' }, { 'openai-responses': [TARGET] })
    expect(await passthroughDenial(RESPONSES, undefined)).toBeUndefined()
    expect(await passthroughDenial(RESPONSES, '')).toBeUndefined()
  })
})
