/**
 * Persona injection is an Anthropic-idiom convenience — it belongs on
 * /v1/messages (Claude Code) but must NOT run on the OpenAI-compat
 * inbound surfaces (/v1/chat/completions, /v1/responses). Leaking a
 * top-level `system` field into an OpenAI-shape body causes strict
 * upstreams (codex) to 400 with `Unsupported parameter: system`, and
 * even lax upstreams (openai chat) see a field the wire format
 * doesn't model.
 *
 * These tests exercise routeScenario directly with an inboundPath and
 * assert `body.system` (the field the pipeline actually reads for
 * persona) is only touched on the Anthropic path. The active persona is
 * the top-level `ActivePersona` on the ConfigStore.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import pino from 'pino'
import { ConfigStore } from '../../src/llms/registry/config'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { routeScenario } from '../../src/llms/scenario-router'
import type { RouterRequest } from '../../src/llms/scenario-router/types'
import { __setSurfacesForTests } from '../../src/services/inbound-surface-service'
import { __setPreferencesForTests } from '../../src/services/router-preference-service'
import { profileWith } from './chain-fixture'

const log = pino({ level: 'silent' })

const PROVIDERS = [
  {
    name: 'anthropic',
    auth_mode: 'api_key',
    api_key: 'sk-x',
    api_base_url: 'https://api.anthropic.com/v1/messages',
    models: ['claude-sonnet-5']
  }
]

async function runRouter(path: string | undefined, body: Record<string, unknown>): Promise<RouterRequest> {
  const config = new ConfigStore({
    Providers: PROVIDERS,
    providers: PROVIDERS,
    Personas: [{ id: 'p1', name: 'brief', prompt: 'You are terse.' }],
    ActivePersona: 'p1'
  })
  const tokenizers = new TokenizerRegistry(log)
  await tokenizers.initialize()
  const req: RouterRequest = {
    body: { ...body, model: 'anthropic,claude-sonnet-5' } as RouterRequest['body'],
    log,
    inboundPath: path
  }
  await routeScenario(req, { config, tokenizers })
  return req
}

// The router's behaviour depends on the surface's mode and the chain, so
// the tests set both rather than inheriting whatever a fresh install
// seeds. These cases describe the routed path.
beforeEach(() => {
  __setSurfacesForTests({ 'anthropic-messages': 'routed' })
  __setPreferencesForTests({ live: profileWith({ 'default.agent': ['anthropic,claude-sonnet-5'] }) })
})

afterEach(() => {
  __setSurfacesForTests({})
  __setPreferencesForTests(null)
})

describe('routeScenario — persona gate', () => {
  test('applies persona on /v1/messages (Anthropic inbound)', async () => {
    const req = await runRouter('/v1/messages', { messages: [{ role: 'user', content: 'hi' }] })
    expect(req.body.system).toBe('You are terse.')
  })

  test('does NOT touch body.system on /v1/chat/completions (OpenAI inbound)', async () => {
    const req = await runRouter('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] })
    expect(req.body.system).toBeUndefined()
  })

  test('does NOT touch body.system on /v1/responses (OpenAI inbound)', async () => {
    const req = await runRouter('/v1/responses', { input: 'hi' })
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
    const config = new ConfigStore({
      Providers: PROVIDERS,
      providers: PROVIDERS,
      Personas: [{ id: 'p1', name: 'brief', prompt: 'You are terse.' }],
      ActivePersona: 'gone'
    })
    const tokenizers = new TokenizerRegistry(log)
    await tokenizers.initialize()
    const req: RouterRequest = {
      body: { model: 'anthropic,claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
      log,
      inboundPath: '/v1/messages'
    }
    await routeScenario(req, { config, tokenizers })
    expect(req.body.system).toBeUndefined()
  })
})
