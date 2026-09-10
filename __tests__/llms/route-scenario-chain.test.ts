/**
 * `routeScenario` end to end, with the chain seeded in place of the
 * database.
 *
 * The contract under test is the one the Routing screen describes: a
 * routed surface walks the chain; when the chain has nothing for the
 * request — an empty lane, every entry gated, the chain failing to
 * load, routing itself throwing — the caller's own `body.model` goes out
 * exactly as it was sent, with no fallbacks. There is no second selector
 * to fall back to, and no invented target.
 *
 * The seeded profile is what makes these honest. Without it, every
 * "routed" test in this process was really exercising the chain
 * failing to load (no DATABASE_URL), and passed on whatever the old
 * slot selector did about that.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import pino from 'pino'
import { ConfigStore } from '../../src/llms/registry/config'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { routeScenario } from '../../src/llms/scenario-router'
import type { RouterRequest } from '../../src/llms/scenario-router/types'
import { clearProviderExhaustion, markProviderExhausted } from '../../src/services/failover-state'
import { __setSurfacesForTests } from '../../src/services/inbound-surface-service'
import { __setPreferencesForTests, PASSTHROUGH_PROFILE_KEY } from '../../src/services/router-preference-service'
import { __resetModelHealthForTest, recordModelFailure } from '../../src/services/routing-scheduler/model-health'
import { __resetSchedulerStateForTest } from '../../src/services/routing-scheduler/state'
import { entry, profileWith } from './chain-fixture'

const log = pino({ level: 'silent' })

const PROVIDERS = [
  {
    name: 'anthropic',
    auth_mode: 'api_key' as const,
    api_key: 'sk-x',
    api_base_url: 'https://api.anthropic.com/v1/messages',
    models: ['claude-sonnet-5', 'claude-opus-4-7', 'claude-haiku-4-5'],
    modelContextWindows: { 'claude-sonnet-5': 200_000 }
  },
  {
    name: 'openai',
    auth_mode: 'api_key' as const,
    api_key: 'sk-y',
    api_base_url: 'https://api.openai.com/v1',
    models: ['gpt-5']
  }
]

const CALLER_MODEL = 'caller,own-model'

type RunOptions = {
  path?: string
  body?: Record<string, unknown>
  profileKeyOverride?: string
  ActivePersona?: string | null
  tokenizers?: TokenizerRegistry
}

async function run(options: RunOptions = {}): Promise<RouterRequest> {
  const config = new ConfigStore({
    Providers: PROVIDERS,
    providers: PROVIDERS,
    Personas: [{ id: 'p1', name: 'brief', prompt: 'You are terse.' }],
    ActivePersona: options.ActivePersona === undefined ? null : options.ActivePersona
  })
  const tokenizers = options.tokenizers === undefined ? new TokenizerRegistry(log) : options.tokenizers
  if (options.tokenizers === undefined) await tokenizers.initialize()
  const req: RouterRequest = {
    body: {
      model: CALLER_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      ...options.body
    } as RouterRequest['body'],
    log,
    inboundPath: options.path === undefined ? '/v1/messages' : options.path,
    ...(options.profileKeyOverride === undefined ? {} : { profileKeyOverride: options.profileKeyOverride })
  }
  await routeScenario(req, { config, tokenizers })
  return req
}

const subagentSystem = () => [
  { type: 'text', text: 'preamble' },
  { type: 'text', text: '<RIALTO-SUBAGENT-MODEL>anything</RIALTO-SUBAGENT-MODEL>' }
]

beforeEach(() => {
  __setSurfacesForTests({ 'anthropic-messages': 'routed' })
  __resetSchedulerStateForTest()
  __resetModelHealthForTest()
  clearProviderExhaustion('anthropic')
  clearProviderExhaustion('openai')
})

afterEach(() => {
  __setSurfacesForTests({})
  __setPreferencesForTests(null)
  __resetModelHealthForTest()
  clearProviderExhaustion('anthropic')
  clearProviderExhaustion('openai')
})

describe('the chain has a primary', () => {
  test('body.model becomes the primary and the rest of the chain rides along as fallbacks', async () => {
    __setPreferencesForTests({
      live: profileWith({ 'default.agent': ['anthropic,claude-sonnet-5', 'openai,gpt-5'] })
    })
    const req = await run()
    expect(req.body.model).toBe('anthropic,claude-sonnet-5')
    expect(req.resolvedFallbacks).toEqual(['openai,gpt-5'])
    expect(req.scenarioType).toBe('default')
    expect(req.isSubagent).toBe(false)
    expect(req.quotaExhaustedRetryAfterSec).toBeUndefined()
  })

  test('the subagent tag selects the subagent lane, and the tag is stripped', async () => {
    __setPreferencesForTests({
      live: profileWith({
        'default.agent': ['anthropic,claude-sonnet-5'],
        'default.subagent': ['anthropic,claude-haiku-4-5', 'openai,gpt-5']
      })
    })
    const req = await run({ body: { system: subagentSystem() } })
    expect(req.isSubagent).toBe(true)
    expect(req.body.model).toBe('anthropic,claude-haiku-4-5')
    expect(req.resolvedFallbacks).toEqual(['openai,gpt-5'])
    const system = req.body.system as { text: string }[]
    expect(system[1].text).toBe('')
  })

  test('proactive failover drops an exhausted primary onto the next chain entry', async () => {
    __setPreferencesForTests({
      live: profileWith({ 'default.agent': ['anthropic,claude-sonnet-5', 'openai,gpt-5'] })
    })
    markProviderExhausted('anthropic')
    const req = await run()
    expect(req.body.model).toBe('openai,gpt-5')
  })

  test('a token-level profile wins over the surface profile', async () => {
    __setPreferencesForTests({
      live: profileWith({ 'default.agent': ['anthropic,claude-sonnet-5'] }),
      'cost-first': profileWith({ 'default.agent': ['openai,gpt-5'] })
    })
    const req = await run({ profileKeyOverride: 'cost-first' })
    expect(req.body.model).toBe('openai,gpt-5')
  })
})

describe('the chain has no primary — the caller keeps its own model', () => {
  test('an empty lane leaves body.model untouched with no fallbacks, whatever exhaustedBehavior says', async () => {
    // The empty-lane shortcut: "nothing configured" is not "everything
    // exhausted", so even a '429' profile does not refuse the request.
    __setPreferencesForTests({ live: profileWith({}, { exhaustedBehavior: '429' }) })
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.quotaExhaustedRetryAfterSec).toBeUndefined()
    expect(req.scenarioType).toBe('default')
  })

  test('every entry gated under exhaustedBehavior passthrough leaves body.model untouched', async () => {
    // The production bug: this used to keep whatever the slot selector
    // had answered. The gate here is the error-rate predicate — a
    // failure just recorded against the only target.
    __setPreferencesForTests({
      live: profileWith({ 'default.agent': ['anthropic,claude-sonnet-5'] }, { exhaustedBehavior: 'passthrough' })
    })
    recordModelFailure('anthropic,claude-sonnet-5')
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.quotaExhaustedRetryAfterSec).toBeUndefined()
  })

  test('every entry gated under exhaustedBehavior 429 stamps a Retry-After and rewrites nothing', async () => {
    __setPreferencesForTests({
      live: profileWith({ 'default.agent': ['anthropic,claude-sonnet-5'] }, { exhaustedBehavior: '429' })
    })
    recordModelFailure('anthropic,claude-sonnet-5')
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.quotaExhaustedRetryAfterSec).toBeGreaterThan(0)
  })

  test('the scenario is still stamped from the request, not reset to default', async () => {
    // A think request with a configured but fully gated think lane is a
    // think request that could not be served — the log line and the
    // request log should say so.
    __setPreferencesForTests({
      live: profileWith(
        { 'default.agent': ['anthropic,claude-sonnet-5'], 'think.agent': ['anthropic,claude-opus-4-7'] },
        { exhaustedBehavior: 'passthrough' }
      )
    })
    recordModelFailure('anthropic,claude-opus-4-7')
    const req = await run({ body: { thinking: { type: 'enabled', budget_tokens: 1024 } } })
    expect(req.scenarioType).toBe('think')
    expect(req.body.model).toBe(CALLER_MODEL)
  })
})

describe('disabled targets never reach the caller', () => {
  test('an entry whose model or provider is switched off is not a primary', async () => {
    __setPreferencesForTests({
      live: profileWith({
        'default.agent': [entry('anthropic,claude-sonnet-5', true, false), 'openai,gpt-5']
      })
    })
    const req = await run()
    expect(req.body.model).toBe('openai,gpt-5')
    expect(req.resolvedFallbacks).toEqual([])
  })

  test('a switched-off fallback is dropped from the chain the failover paths walk', async () => {
    __setPreferencesForTests({
      live: profileWith({
        'default.agent': ['anthropic,claude-sonnet-5', entry('anthropic,claude-opus-4-7', true, false), 'openai,gpt-5']
      })
    })
    const req = await run()
    expect(req.body.model).toBe('anthropic,claude-sonnet-5')
    expect(req.resolvedFallbacks).toEqual(['openai,gpt-5'])
  })

  test('a lane whose only entries are switched off does not count as configured', async () => {
    // The classifier must not land on `think` here: the selector would
    // skip the entry and the request would drop onto the caller's
    // model when the default lane could have served it.
    __setPreferencesForTests({
      live: profileWith({
        'default.agent': ['anthropic,claude-sonnet-5'],
        'think.agent': [entry('anthropic,claude-opus-4-7', true, false)]
      })
    })
    const req = await run({ body: { thinking: { type: 'enabled', budget_tokens: 1024 } } })
    expect(req.scenarioType).toBe('default')
    expect(req.body.model).toBe('anthropic,claude-sonnet-5')
  })
})

describe('the chain cannot be consulted', () => {
  test('a chain that fails to load leaves body.model untouched', async () => {
    __setPreferencesForTests({ live: new Error('database is away') })
    const req = await run({ body: { system: subagentSystem() } })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.scenarioType).toBe('default')
    // The lane is still read off the tag, and the tag still stripped.
    expect(req.isSubagent).toBe(true)
    const system = req.body.system as { text: string }[]
    expect(system[1].text).toBe('')
  })

  test('routing throwing before the chain is reached leaves body.model untouched', async () => {
    __setPreferencesForTests({ live: profileWith({ 'default.agent': ['anthropic,claude-sonnet-5'] }) })
    const broken = { countTokens: async () => Promise.reject(new Error('tokenizer exploded')) }
    const req = await run({ tokenizers: broken as unknown as TokenizerRegistry })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.scenarioType).toBe('default')
    expect(req.isSubagent).toBe(false)
  })
})

describe('passthrough', () => {
  test('a token naming the reserved passthrough profile skips the chain on a routed surface', async () => {
    __setPreferencesForTests({ live: profileWith({ 'default.agent': ['anthropic,claude-sonnet-5'] }) })
    const req = await run({ profileKeyOverride: PASSTHROUGH_PROFILE_KEY })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.tokenCount).toBeUndefined()
  })

  test('a passthrough surface skips the chain even when the chain has a primary', async () => {
    __setSurfacesForTests({ 'anthropic-messages': 'passthrough' })
    __setPreferencesForTests({ live: profileWith({ 'default.agent': ['anthropic,claude-sonnet-5'] }) })
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
  })
})

describe('the persona rides on every routed /v1/messages exit', () => {
  test('when the chain found a primary', async () => {
    __setPreferencesForTests({ live: profileWith({ 'default.agent': ['anthropic,claude-sonnet-5'] }) })
    const req = await run({ ActivePersona: 'p1' })
    expect(req.body.system).toBe('You are terse.')
  })

  test('when the chain had no primary', async () => {
    __setPreferencesForTests({ live: profileWith({}) })
    const req = await run({ ActivePersona: 'p1' })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.body.system).toBe('You are terse.')
  })

  test('when the chain failed to load', async () => {
    __setPreferencesForTests({ live: new Error('database is away') })
    const req = await run({ ActivePersona: 'p1' })
    expect(req.body.system).toBe('You are terse.')
  })

  test('not on a passthrough surface, which gets exactly what it sent', async () => {
    __setSurfacesForTests({ 'anthropic-messages': 'passthrough' })
    const req = await run({ ActivePersona: 'p1' })
    expect(req.body.system).toBeUndefined()
  })
})
