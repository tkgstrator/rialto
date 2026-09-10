/**
 * Parity matrix — surface parity for routing itself.
 *
 * Every one of the matrix's ten rows asks whether a surface can express a
 * feature. Before any of them comes a prior question: can routing be
 * turned on per surface at all (master-plan §2-5's second completion
 * condition). This used to be hard-coded in `scenario-router.ts`, where
 * anything but /v1/messages passed through unconditionally — which made
 * the entire Routing screen a /v1/messages-only screen. The mode is now a
 * per-surface setting, so all four behave symmetrically.
 *
 * One asymmetry remains, and it is deliberate:
 *   - persona injection is /v1/messages only, because on the other
 *     surfaces a top-level `system` is an unknown field that some
 *     upstreams answer with 400
 *
 * longContext token counting used to read `body.messages` directly and so
 * always saw 0 in the Responses and Gemini vocabularies. It now goes
 * through the per-surface normalised signals
 * (`scenario-router/surface-signals.ts`) and counts on all four.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import pino from 'pino'
import type { SurfaceId } from '../../src/llms/inbound/surfaces'
import { ConfigStore } from '../../src/llms/registry/config'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { routeScenario } from '../../src/llms/scenario-router'
import type { RouterRequest } from '../../src/llms/scenario-router/types'
import { __setSurfacesForTests } from '../../src/services/inbound-surface-service'
import { __setPreferencesForTests } from '../../src/services/router-preference-service'
import { profileWith } from '../llms/chain-fixture'

const log = pino({ level: 'silent' })

const PROVIDERS = [
  {
    name: 'anthropic',
    auth_mode: 'api_key' as const,
    api_key: 'sk-x',
    api_base_url: 'https://api.anthropic.com/v1/messages',
    models: ['claude-sonnet-5', 'claude-opus-4-7']
  }
]

async function run(path: string, body: Record<string, unknown>): Promise<RouterRequest> {
  const config = new ConfigStore({ Providers: PROVIDERS, providers: PROVIDERS })
  const tokenizers = new TokenizerRegistry(log)
  await tokenizers.initialize()
  const req: RouterRequest = {
    body: { model: 'caller,own-model', ...body } as RouterRequest['body'],
    log,
    inboundPath: path
  }
  await routeScenario(req, { config, tokenizers })
  return req
}

const SURFACES: ReadonlyArray<[SurfaceId, string]> = [
  ['anthropic-messages', '/v1/messages'],
  ['openai-chat', '/v1/chat/completions'],
  ['openai-responses', '/v1/responses'],
  ['gemini-generate', '/v1beta/models/gemini-3-pro:generateContent']
]

// The mode and the chain both land in module-scope caches, so restore
// them on both sides. These share a process with the other test files,
// and skipping the cleanup leaves a neighbour where routing is
// mysteriously on.
beforeEach(() => {
  __setSurfacesForTests({})
  __setPreferencesForTests({
    live: profileWith({ 'default.agent': ['anthropic,claude-sonnet-5', 'anthropic,claude-opus-4-7'] })
  })
})

afterEach(() => {
  __setSurfacesForTests({})
  __setPreferencesForTests(null)
})

describe('the mode takes effect on all four surfaces', () => {
  for (const [id, path] of SURFACES) {
    test(`${id} — routed rewrites the model to the chain's primary`, async () => {
      __setSurfacesForTests({ [id]: 'routed' })
      const req = await run(path, { messages: [{ role: 'user', content: 'hi' }] })
      expect(req.body.model).toBe('anthropic,claude-sonnet-5')
      expect(req.resolvedFallbacks).toEqual(['anthropic,claude-opus-4-7'])
    })

    test(`${id} — passthrough keeps the caller's model and leaves the chain empty`, async () => {
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

  test('longContext token counting reads all four vocabularies', async () => {
    // `countRequestTokens` used to read body.messages, body.system and
    // body.tools directly. Responses puts the body under `input` /
    // `instructions` and Gemini under `contents`, so however long the
    // conversation it counted 0 and there was no road into the
    // longContext lane. Counting now goes through signalsOf() and reads
    // each surface's own vocabulary.
    __setSurfacesForTests({
      'anthropic-messages': 'routed',
      'openai-chat': 'routed',
      'openai-responses': 'routed',
      'gemini-generate': 'routed'
    })
    const long = 'lorem ipsum dolor sit amet '.repeat(200)

    const anthropic = await run('/v1/messages', { messages: [{ role: 'user', content: long }] })
    const chat = await run('/v1/chat/completions', { messages: [{ role: 'user', content: long }] })
    const responses = await run('/v1/responses', { input: long, instructions: 'be terse' })
    const gemini = await run('/v1beta/models/gemini-3-pro:generateContent', {
      contents: [{ role: 'user', parts: [{ text: long }] }]
    })

    expect(anthropic.tokenCount).toBeGreaterThan(0)
    expect(chat.tokenCount).toBeGreaterThan(0)
    expect(responses.tokenCount).toBeGreaterThan(0)
    expect(gemini.tokenCount).toBeGreaterThan(0)
  })
})
