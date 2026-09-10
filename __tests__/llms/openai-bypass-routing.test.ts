/**
 * A surface in passthrough skips the chain entirely: the caller's
 * `body.model` reaches upstream verbatim, no classification / chain /
 * persona runs.
 *
 * A routed surface and legacy callers without an inboundPath go through
 * the chain.
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
  },
  {
    name: 'openai',
    auth_mode: 'api_key',
    api_key: 'sk-y',
    api_base_url: 'https://api.openai.com/v1/chat/completions',
    models: ['gpt-5']
  }
]

async function runRouter(path: string | undefined, bodyModel: string): Promise<RouterRequest> {
  const config = new ConfigStore({ Providers: PROVIDERS, providers: PROVIDERS })
  const tokenizers = new TokenizerRegistry(log)
  await tokenizers.initialize()
  const req: RouterRequest = {
    body: { model: bodyModel, messages: [{ role: 'user', content: 'hi' }] } as RouterRequest['body'],
    log,
    inboundPath: path
  }
  await routeScenario(req, { config, tokenizers })
  return req
}

// The router's behaviour depends on the surface's mode and the chain, so
// the tests set both rather than inheriting whatever a fresh install
// seeds. These cases describe /v1/messages routed, the OpenAI surfaces
// in passthrough.
beforeEach(() => {
  __setSurfacesForTests({ 'anthropic-messages': 'routed' })
  __setPreferencesForTests({ live: profileWith({ 'default.agent': ['anthropic,claude-sonnet-5'] }) })
})

afterEach(() => {
  __setSurfacesForTests({})
  __setPreferencesForTests(null)
})

describe('routeScenario — passthrough surfaces', () => {
  test('/v1/chat/completions keeps body.model verbatim (no rewrite to the chain primary)', async () => {
    const req = await runRouter('/v1/chat/completions', 'openai,gpt-5')
    expect(req.body.model).toBe('openai,gpt-5')
    expect(req.scenarioType).toBe('default')
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.isSubagent).toBe(false)
  })

  test('/v1/responses keeps body.model verbatim', async () => {
    const req = await runRouter('/v1/responses', 'openai,gpt-5')
    expect(req.body.model).toBe('openai,gpt-5')
    expect(req.scenarioType).toBe('default')
    expect(req.resolvedFallbacks).toEqual([])
  })

  test('/v1/messages does NOT bypass — the chain runs (tokenCount stamped, model rewritten)', async () => {
    // The passthrough early-return skips the countRequestTokens call, so
    // req.tokenCount stays undefined; on a routed surface the router
    // runs it and stamps a numeric value.
    const req = await runRouter('/v1/messages', 'openai,gpt-5')
    expect(typeof req.tokenCount).toBe('number')
    expect(req.body.model).toBe('anthropic,claude-sonnet-5')
  })

  test('missing inboundPath (legacy caller) also does NOT bypass — backward compat', async () => {
    const req = await runRouter(undefined, 'openai,gpt-5')
    expect(typeof req.tokenCount).toBe('number')
  })
})
