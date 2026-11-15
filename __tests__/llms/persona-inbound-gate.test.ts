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

import { describe, expect, test } from 'bun:test'
import pino from 'pino'
import { ConfigStore } from '../../src/llms/registry/config'
import { routeRequest } from '../../src/llms/router'
import type { RouterRequest } from '../../src/llms/router/types'

const log = pino({ level: 'silent' })

const personaConfig = (activePersona: string): ConfigStore =>
  new ConfigStore({
    Personas: [{ id: 'p1', name: 'brief', prompt: 'You are terse.' }],
    ActivePersona: activePersona
  })

function runRouter(
  path: string | undefined,
  body: Record<string, unknown>,
  config: ConfigStore = personaConfig('p1')
): RouterRequest {
  const req: RouterRequest = {
    body: { ...body, model: 'anthropic,claude-sonnet-5' },
    log,
    inboundPath: path
  }
  routeRequest(req, { config })
  return req
}

describe('routeRequest — persona gate', () => {
  test('applies persona on /v1/messages (Anthropic inbound)', () => {
    const req = runRouter('/v1/messages', { messages: [{ role: 'user', content: 'hi' }] })
    expect(req.body.system).toBe('You are terse.')
  })

  test('does NOT touch body.system on /v1/chat/completions (OpenAI inbound)', () => {
    const req = runRouter('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] })
    expect(req.body.system).toBeUndefined()
  })

  test('does NOT touch body.system on /v1/responses (OpenAI inbound)', () => {
    const req = runRouter('/v1/responses', { input: 'hi' })
    expect(req.body.system).toBeUndefined()
  })

  test('missing inboundPath (test/legacy callers) still applies persona — backward compat', () => {
    const req = runRouter(undefined, { messages: [{ role: 'user', content: 'hi' }] })
    expect(req.body.system).toBe('You are terse.')
  })

  test('composes with caller-supplied Anthropic system when active', () => {
    const req = runRouter('/v1/messages', {
      messages: [{ role: 'user', content: 'hi' }],
      system: 'Existing prefix.'
    })
    expect(req.body.system).toBe('Existing prefix.\n\nYou are terse.')
  })

  test('a persona id that matches nothing in the library is a no-op', () => {
    const req = runRouter('/v1/messages', { messages: [{ role: 'user', content: 'hi' }] }, personaConfig('gone'))
    expect(req.body.system).toBeUndefined()
  })
})
