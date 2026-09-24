/**
 * Parity matrix — surface parity for routing itself.
 *
 * Every one of the matrix's ten rows asks whether a surface can express a
 * feature. Before any of them comes a prior question: can routing be
 * turned on per surface at all (master-plan §2-5's second completion
 * condition). This used to be hard-coded in `router.ts`, where
 * anything but /v1/messages passed through unconditionally — which made
 * the entire Routing screen a /v1/messages-only screen. The mode is now a
 * per-surface setting, so all four behave symmetrically.
 *
 * One asymmetry remains, and it is deliberate:
 *   - persona injection is /v1/messages only, because on the other
 *     surfaces a top-level `system` is an unknown field that some
 *     upstreams answer with 400
 *
 * Token counting used to read `body.messages` directly and so always saw
 * 0 in the Responses and Gemini vocabularies. It now goes through the
 * per-surface normalised signals (`router/surface-signals.ts`)
 * and counts on all four, which is what the tier map's context gate
 * weighs a prompt with.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import pino from 'pino'
import type { SurfaceId } from '../../src/llms/inbound/surfaces'
import { ConfigStore } from '../../src/llms/registry/config'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { routeRequest } from '../../src/llms/router'
import type { RouterRequest } from '../../src/llms/router/types'
import { __setTierProfilesForTests } from '../../src/llms/tier-router/runtime'
import { __setSurfacesForTests } from '../../src/services/inbound-surface-service'
import { mapWith, route } from '../llms/tier-fixture'

const log = pino({ level: 'silent' })
const tokenizers = new TokenizerRegistry(log)

beforeAll(async () => {
  await tokenizers.initialize()
})

async function run(path: string, body: Record<string, unknown>): Promise<RouterRequest> {
  const req: RouterRequest = {
    body: { ...body, model: 'caller,own-model' },
    log,
    inboundPath: path
  }
  await routeRequest(req, { config: new ConfigStore({}), tokenizers })
  return req
}

// The caller's model names no Claude family, so every surface asks for
// the "other" tier; the map serves it with two routes.
const otherRoutes = (contextWindow: number | null = null) =>
  mapWith({
    other: [
      route('anthropic', 'sonnet', 'claude-sonnet-5', { contextWindow }),
      route('anthropic', 'opus', 'claude-opus-4-7', { contextWindow })
    ]
  })

const SURFACES: ReadonlyArray<[SurfaceId, string]> = [
  ['anthropic-messages', '/v1/messages'],
  ['openai-chat', '/v1/chat/completions'],
  ['openai-responses', '/v1/responses'],
  ['gemini-generate', '/v1beta/models/gemini-3-pro:generateContent']
]

// The mode and the map both land in module-scope caches, so restore
// them on both sides. These share a process with the other test files,
// and skipping the cleanup leaves a neighbour where routing is
// mysteriously on.
beforeEach(() => {
  __setSurfacesForTests({})
  __setTierProfilesForTests({ live: otherRoutes() })
})

afterEach(() => {
  __setSurfacesForTests({})
  __setTierProfilesForTests(null)
})

describe('the mode takes effect on all four surfaces', () => {
  for (const [id, path] of SURFACES) {
    test(`${id} — routed rewrites the model to the tier's primary`, async () => {
      __setSurfacesForTests({ [id]: 'routed' })
      const req = await run(path, { messages: [{ role: 'user', content: 'hi' }] })
      expect(req.body.model).toBe('anthropic,claude-sonnet-5')
      expect(req.resolvedFallbacks).toEqual(['anthropic,claude-opus-4-7'])
    })

    test(`${id} — passthrough keeps the caller's model and leaves the fallbacks empty`, async () => {
      __setSurfacesForTests({ [id]: 'passthrough' })
      const req = await run(path, { messages: [{ role: 'user', content: 'hi' }] })
      expect(req.body.model).toBe('caller,own-model')
      expect(req.resolvedFallbacks).toEqual([])
    })
  }

  test('the modes are independent: routing one surface leaves the others passing through', async () => {
    __setSurfacesForTests({ 'anthropic-messages': 'routed' })
    const routed = await run('/v1/messages', { messages: [{ role: 'user', content: 'hi' }] })
    const untouched = await run('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] })
    expect(routed.body.model).toBe('anthropic,claude-sonnet-5')
    expect(untouched.body.model).toBe('caller,own-model')
  })
})

describe('the deliberate asymmetry', () => {
  test('persona injection is limited to /v1/messages', async () => {
    // Adding a top-level `system` on an OpenAI-compatible surface makes
    // the upstream — codex being the standing example — answer 400 for an
    // unknown parameter. So it is not injected.
    __setSurfacesForTests({ 'anthropic-messages': 'routed', 'openai-chat': 'routed' })
    const anthropic = await run('/v1/messages', { messages: [{ role: 'user', content: 'hi' }] })
    const openai = await run('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] })
    // Even with no persona configured the field's presence differs:
    // only /v1/messages goes through applyGlobalSystemPrompt.
    expect('system' in anthropic.body).toBe(true)
    expect('system' in openai.body).toBe(false)
  })

  test('token counting reads all four vocabularies, so the context gate holds on each', async () => {
    // `countRequestTokens` used to read body.messages, body.system and
    // body.tools directly. Responses puts the body under `input` /
    // `instructions` and Gemini under `contents`, so however long the
    // conversation it counted 0, and a prompt no route could hold went
    // upstream anyway. Counting now goes through signalsOf() and reads
    // each surface's own vocabulary, which is what the context gate weighs.
    __setSurfacesForTests({
      'anthropic-messages': 'routed',
      'openai-chat': 'routed',
      'openai-responses': 'routed',
      'gemini-generate': 'routed'
    })
    __setTierProfilesForTests({ live: otherRoutes(100) })
    const long = 'lorem ipsum dolor sit amet '.repeat(200)

    const anthropic = await run('/v1/messages', { messages: [{ role: 'user', content: long }] })
    const chat = await run('/v1/chat/completions', { messages: [{ role: 'user', content: long }] })
    const responses = await run('/v1/responses', { input: long, instructions: 'be terse' })
    const gemini = await run('/v1beta/models/gemini-3-pro:generateContent', {
      contents: [{ role: 'user', parts: [{ text: long }] }]
    })

    for (const req of [anthropic, chat, responses, gemini]) {
      expect(req.tokenCount).toBeGreaterThan(100)
      expect(req.routingRefusal).toContain('context window')
      expect(req.body.model).toBe('caller,own-model')
    }
  })
})
