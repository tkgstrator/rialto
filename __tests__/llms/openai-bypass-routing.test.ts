/**
 * A surface in passthrough skips the tier map entirely: the caller's
 * `body.model` reaches upstream verbatim, no token count / map / persona
 * runs.
 *
 * A routed surface and legacy callers without an inboundPath go through
 * the map.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import pino from 'pino'
import { ConfigStore } from '../../src/llms/registry/config'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { PASSTHROUGH_ROUTE, routeRequest } from '../../src/llms/router'
import type { RouterRequest } from '../../src/llms/router/types'
import { __setTierProfilesForTests } from '../../src/llms/tier-router/runtime'
import { __setSurfacesForTests } from '../../src/services/inbound-surface-service'
import { mapWith, route } from './tier-fixture'

const log = pino({ level: 'silent' })
const tokenizers = new TokenizerRegistry(log)

beforeAll(async () => {
  await tokenizers.initialize()
})

async function runRouter(path: string | undefined, bodyModel: string): Promise<RouterRequest> {
  const req: RouterRequest = {
    body: { model: bodyModel, messages: [{ role: 'user', content: 'hi' }] },
    log,
    inboundPath: path
  }
  await routeRequest(req, { config: new ConfigStore({}), tokenizers })
  return req
}

// The router's behaviour depends on the surface's mode and the map, so
// the tests set both rather than inheriting whatever a fresh install
// seeds. These cases describe /v1/messages routed, the OpenAI surfaces
// in passthrough. `openai,gpt-5` names no Claude family, so it asks for
// the "other" tier, which the map serves.
beforeEach(() => {
  __setSurfacesForTests({ 'anthropic-messages': 'routed' })
  __setTierProfilesForTests({ live: mapWith({ other: [route('anthropic', 'sonnet', 'claude-sonnet-5')] }) })
})

afterEach(() => {
  __setSurfacesForTests({})
  __setTierProfilesForTests(null)
})

describe('routeRequest — passthrough surfaces', () => {
  test('/v1/chat/completions keeps body.model verbatim (no rewrite to the tier primary)', async () => {
    const req = await runRouter('/v1/chat/completions', 'openai,gpt-5')
    expect(req.body.model).toBe('openai,gpt-5')
    expect(req.route).toBe(PASSTHROUGH_ROUTE)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.isSubagent).toBe(false)
  })

  test('/v1/responses keeps body.model verbatim', async () => {
    const req = await runRouter('/v1/responses', 'openai,gpt-5')
    expect(req.body.model).toBe('openai,gpt-5')
    expect(req.route).toBe(PASSTHROUGH_ROUTE)
    expect(req.resolvedFallbacks).toEqual([])
  })

  test('/v1/messages does NOT bypass — the map runs (tokenCount stamped, model rewritten)', async () => {
    // The passthrough early-return skips the countRequestTokens call, so
    // req.tokenCount stays undefined; on a routed surface the router
    // runs it and stamps a numeric value.
    const req = await runRouter('/v1/messages', 'openai,gpt-5')
    expect(typeof req.tokenCount).toBe('number')
    expect(req.body.model).toBe('anthropic,claude-sonnet-5')
    expect(req.route).toBe('other')
  })

  test('missing inboundPath (legacy caller) also does NOT bypass — backward compat', async () => {
    const req = await runRouter(undefined, 'openai,gpt-5')
    expect(typeof req.tokenCount).toBe('number')
  })
})
