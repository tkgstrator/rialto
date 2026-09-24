/**
 * Persona injection is an Anthropic-idiom convenience — it belongs on
 * /v1/messages (Claude Code) but must NOT run on the OpenAI-compat
 * inbound surfaces (/v1/chat/completions, /v1/responses). Leaking a
 * top-level `system` field into an OpenAI-shape body causes strict
 * upstreams (codex) to 400 with `Unsupported parameter: system`, and
 * even lax upstreams (openai chat) see a field the wire format
 * doesn't model.
 *
 * These tests exercise routeRequest directly with an inboundPath and
 * assert `body.system` (the field the pipeline actually reads for
 * persona) is only touched on the Anthropic path. The active persona is
 * the top-level `ActivePersona` on the ConfigStore.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import pino from 'pino'
import { ConfigStore } from '../../src/llms/registry/config'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { routeRequest } from '../../src/llms/router'
import type { RouterRequest } from '../../src/llms/router/types'
import { __setTierProfilesForTests } from '../../src/llms/tier-router/runtime'
import { __setSurfacesForTests } from '../../src/services/inbound-surface-service'
import { mapWith, route } from './tier-fixture'

const log = pino({ level: 'silent' })
const tokenizers = new TokenizerRegistry(log)

beforeAll(async () => {
  await tokenizers.initialize()
})

const personaConfig = (activePersona: string): ConfigStore =>
  new ConfigStore({
    Personas: [{ id: 'p1', name: 'brief', prompt: 'You are terse.' }],
    ActivePersona: activePersona
  })

async function runRouter(
  path: string | undefined,
  body: Record<string, unknown>,
  config: ConfigStore = personaConfig('p1')
): Promise<RouterRequest> {
  const req: RouterRequest = {
    body: { ...body, model: 'anthropic,claude-sonnet-5' },
    log,
    inboundPath: path
  }
  await routeRequest(req, { config, tokenizers })
  return req
}

// The router's behaviour depends on the surface's mode and the routes,
// so the tests set both rather than inheriting whatever a fresh install
// seeds. All three surfaces are routed, so the OpenAI cases are held back
// by the persona gate itself and not by the passthrough early return.
beforeEach(() => {
  __setSurfacesForTests({ 'anthropic-messages': 'routed', 'openai-chat': 'routed', 'openai-responses': 'routed' })
  __setTierProfilesForTests({
    live: mapWith({ default: { agent: [route('anthropic', 'sonnet', 'claude-sonnet-5')] } })
  })
})

afterEach(() => {
  __setSurfacesForTests({})
  __setTierProfilesForTests(null)
})

describe('routeRequest — persona gate', () => {
  test('applies persona on /v1/messages (Anthropic inbound)', async () => {
    const req = await runRouter('/v1/messages', { messages: [{ role: 'user', content: 'hi' }] })
    expect(req.body.system).toBe('You are terse.')
  })

  test('does NOT touch body.system on /v1/chat/completions (OpenAI inbound)', async () => {
    const req = await runRouter('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] })
    // Routed, so the gate — not a skipped router — is what kept it out.
    expect(req.route).toBe('default')
    expect(req.body.system).toBeUndefined()
  })

  test('does NOT touch body.system on /v1/responses (OpenAI inbound)', async () => {
    const req = await runRouter('/v1/responses', { input: 'hi' })
    expect(req.route).toBe('default')
    expect(req.body.system).toBeUndefined()
  })

  test('missing inboundPath (test/legacy callers) still applies persona — backward compat', async () => {
    const req = await runRouter(undefined, { messages: [{ role: 'user', content: 'hi' }] })
    expect(req.body.system).toBe('You are terse.')
  })

  test('composes with caller-supplied Anthropic system when active', async () => {
    const req = await runRouter('/v1/messages', {
      messages: [{ role: 'user', content: 'hi' }],
      system: 'Existing prefix.'
    })
    expect(req.body.system).toBe('Existing prefix.\n\nYou are terse.')
  })

  test('a persona id that matches nothing in the library is a no-op', async () => {
    const req = await runRouter('/v1/messages', { messages: [{ role: 'user', content: 'hi' }] }, personaConfig('gone'))
    expect(req.body.system).toBeUndefined()
  })
})
