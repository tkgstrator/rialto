/**
 * `routeRequest` end to end, with the tier map seeded in place of the
 * database.
 *
 * The contract under test is the one the Routing screen describes: a
 * routed surface reads the tier off the requested model name and walks
 * that tier's routes in order. When the map has nothing for the request,
 * what happens depends on why:
 *
 *   | the tier's routes                         | body.model | answer                    |
 *   |-------------------------------------------|------------|---------------------------|
 *   | none                                      | untouched  | upstream as sent, no 429  |
 *   | every route or target switched off        | untouched  | upstream as sent, no 429  |
 *   | every route held on quota / health, '429' | untouched  | 429 + Retry-After         |
 *   | the same under 'passthrough'              | untouched  | upstream as sent          |
 *   | configured, but none can take THIS request| untouched  | 400 (routingRefusal)      |
 *   | the map fails to load / routing throws    | untouched  | upstream as sent, logged  |
 *
 * `routeRequest` never invents a target: `body.model` is only ever
 * rewritten to a route's resolved target.
 *
 * The seeded profiles are what make these honest. `__setTierProfilesForTests`
 * is set to an empty seed before every test, so a test that forgets to
 * seed one reads an empty map rather than reaching for Postgres.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import pino from 'pino'
import dayjs from '../../src/lib/dayjs'
import { ConfigStore } from '../../src/llms/registry/config'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { PASSTHROUGH_ROUTE, routeRequest } from '../../src/llms/router'
import type { RouterRequest, RouterRequestBody } from '../../src/llms/router/types'
import { __setTierProfilesForTests } from '../../src/llms/tier-router/runtime'
import {
  clearModelExhaustion,
  clearProviderExhaustion,
  markModelExhausted,
  markProviderExhausted
} from '../../src/services/failover-state'
import { __setSurfacesForTests } from '../../src/services/inbound-surface-service'
import { __resetModelHealthForTest, recordModelFailure } from '../../src/services/routing-scheduler/model-health'
import { __resetSchedulerStateForTest, publishSnapshot } from '../../src/services/routing-scheduler/state'
import type { TargetQuotaState } from '../../src/services/routing-scheduler/types'
import { PASSTHROUGH_PROFILE_KEY } from '../../src/services/tier-route-service'
import { mapWith, route } from './tier-fixture'

// Every line the router logs, so the failure path can be asserted as
// logged rather than silently swallowed.
const logged: { lines: string[] } = { lines: [] }
const log = pino(
  { level: 'info' },
  {
    write: (line: string) => {
      logged.lines.push(line)
    }
  }
)

const tokenizers = new TokenizerRegistry()
beforeAll(async () => {
  await tokenizers.initialize()
})

// What Claude Code sends: a bare model name whose family is the tier.
const CALLER_MODEL = 'claude-sonnet-4-5'
const SONNET = 'claude-code,claude-sonnet-5'
const CODEX = 'codex,gpt-5.5'

const sonnetRoute = (over: Parameters<typeof route>[3] = {}) => route('claude-code', 'sonnet', 'claude-sonnet-5', over)
const codexRoute = (over: Parameters<typeof route>[3] = {}) => route('codex', 'sonnet', 'gpt-5.5', over)

type RunOptions = {
  model?: string
  // Wire-shaped, as a client sends it: a web_search tool entry is not a
  // TokenizeTool, and the router has to cope with that anyway.
  body?: Record<string, unknown>
  path?: string
  profileKeyOverride?: string
  ActivePersona?: string | null
  tokenizers?: TokenizerRegistry
}

async function run(options: RunOptions = {}): Promise<RouterRequest> {
  // The router reads only the persona off the config now; which model a
  // route reaches is resolved by the map, not by the provider list.
  const config = new ConfigStore({
    Personas: [{ id: 'p1', name: 'brief', prompt: 'You are terse.' }],
    ActivePersona: options.ActivePersona === undefined ? null : options.ActivePersona
  })
  const req: RouterRequest = {
    body: {
      messages: [{ role: 'user', content: 'hi' }],
      ...options.body,
      model: options.model === undefined ? CALLER_MODEL : options.model
    },
    log,
    inboundPath: options.path === undefined ? '/v1/messages' : options.path,
    ...(options.profileKeyOverride === undefined ? {} : { profileKeyOverride: options.profileKeyOverride })
  }
  await routeRequest(req, { config, tokenizers: options.tokenizers === undefined ? tokenizers : options.tokenizers })
  return req
}

const subagentSystem = () => [
  { type: 'text', text: 'preamble' },
  { type: 'text', text: '<RIALTO-SUBAGENT-MODEL>anything</RIALTO-SUBAGENT-MODEL>' }
]

const textOf = (system: RouterRequestBody['system'], index: number): string | undefined => {
  const text = Array.isArray(system) ? system[index]?.text : undefined
  return typeof text === 'string' ? text : undefined
}

// One scheduler tick's worth of quota readings, keyed by target.
const publishQuota = (targets: Record<string, Omit<TargetQuotaState, 'target'>>): void => {
  publishSnapshot({
    tickAt: dayjs().valueOf(),
    tickCount: 1,
    consecutiveFailures: 0,
    degraded: false,
    targets: new Map(Object.entries(targets).map(([target, state]) => [target, { target, ...state }])),
    accounts: [],
    soonestResetAt: null
  })
}

// The health gate needs `minHealthSamples` (5 by default) before a rate
// means anything, so one failure is not enough to hold a route.
const failRepeatedly = (target: string, times = 5): void => {
  for (const _ of Array.from({ length: times })) recordModelFailure(target)
}

const resetLiveState = (): void => {
  __resetSchedulerStateForTest()
  __resetModelHealthForTest()
  clearModelExhaustion('claude-code', 'claude-sonnet-5')
  clearModelExhaustion('codex', 'gpt-5.5')
  clearProviderExhaustion('claude-code')
  clearProviderExhaustion('codex')
}

beforeEach(() => {
  __setSurfacesForTests({ 'anthropic-messages': 'routed' })
  __setTierProfilesForTests({})
  resetLiveState()
  logged.lines = []
})

afterEach(() => {
  __setSurfacesForTests({})
  __setTierProfilesForTests(null)
  resetLiveState()
})

describe('a route can serve the request', () => {
  test('body.model becomes the first route that passes and the rest ride along as fallbacks', async () => {
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute(), codexRoute()] }) })
    const req = await run()
    expect(req.body.model).toBe(SONNET)
    expect(req.resolvedFallbacks).toEqual([CODEX])
    expect(req.route).toBe('sonnet')
    expect(req.isSubagent).toBe(false)
    expect(typeof req.tokenCount).toBe('number')
    expect(req.quotaExhaustedRetryAfterSec).toBeUndefined()
    expect(req.routingRefusal).toBeUndefined()
  })

  test('the tier is read off the requested model name', async () => {
    __setTierProfilesForTests({
      live: mapWith({
        opus: [route('claude-code', 'opus', 'claude-opus-4-7')],
        sonnet: [sonnetRoute()],
        other: [codexRoute()]
      })
    })
    const opus = await run({ model: 'claude-opus-4-7' })
    expect(opus.body.model).toBe('claude-code,claude-opus-4-7')
    expect(opus.route).toBe('opus')
    // A provider-qualified name still names its family.
    const qualified = await run({ model: 'anthropic,claude-sonnet-4-5' })
    expect(qualified.body.model).toBe(SONNET)
    expect(qualified.route).toBe('sonnet')
    // No Claude family in the name is the "other" tier.
    const other = await run({ model: 'gpt-5' })
    expect(other.body.model).toBe(CODEX)
    expect(other.route).toBe('other')
  })

  test('a route may serve another tier than the one asked for; the map says so', async () => {
    // What used to be tier escalation is now just a route: haiku traffic
    // served by the sonnet alias, written where the operator can see it.
    __setTierProfilesForTests({ live: mapWith({ haiku: [sonnetRoute()] }) })
    const req = await run({ model: 'claude-haiku-4-5' })
    expect(req.body.model).toBe(SONNET)
    expect(req.route).toBe('haiku')
  })

  test('a token-level profile wins over the surface profile', async () => {
    __setTierProfilesForTests({
      live: mapWith({ sonnet: [sonnetRoute()] }),
      'cost-first': mapWith({ sonnet: [codexRoute()] }, {}, 'cost-first')
    })
    const req = await run({ profileKeyOverride: 'cost-first' })
    expect(req.body.model).toBe(CODEX)
  })

  test('a route marked exhausted by a 429 is skipped for the next', async () => {
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute(), codexRoute()] }) })
    markModelExhausted('claude-code', 'claude-sonnet-5')
    expect((await run()).body.model).toBe(CODEX)
  })

  test('a provider-wide mark holds every route on that provider', async () => {
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute(), codexRoute()] }) })
    markProviderExhausted('claude-code')
    expect((await run()).body.model).toBe(CODEX)
  })

  test('a route the quota snapshot reads as spent is skipped', async () => {
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute(), codexRoute()] }) })
    publishQuota({ [SONNET]: { exhausted: true, remainingBudgetPct: 0, resetAt: dayjs().add(1, 'hour').valueOf() } })
    expect((await run()).body.model).toBe(CODEX)
  })

  test('quotaSkipPct holds a route used at or past it, and only then', async () => {
    __setTierProfilesForTests({
      live: mapWith({ sonnet: [sonnetRoute(), codexRoute()] }, { quotaSkipPct: 80 })
    })
    publishQuota({ [SONNET]: { exhausted: false, remainingBudgetPct: 15, resetAt: null } })
    expect((await run()).body.model).toBe(CODEX)
    publishQuota({ [SONNET]: { exhausted: false, remainingBudgetPct: 25, resetAt: null } })
    expect((await run()).body.model).toBe(SONNET)
  })

  test('a target the snapshot has never seen is not held on quota', async () => {
    // api_key providers have no quota the scheduler reads; the upstream's
    // own 429 is the judge for them.
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute(), codexRoute()] }) })
    publishQuota({ [CODEX]: { exhausted: true, remainingBudgetPct: 0, resetAt: null } })
    expect((await run()).body.model).toBe(SONNET)
  })

  test('a failing route is skipped once it has enough samples, not before', async () => {
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute(), codexRoute()] }) })
    failRepeatedly(SONNET, 4)
    expect((await run()).body.model).toBe(SONNET)
    recordModelFailure(SONNET)
    expect((await run()).body.model).toBe(CODEX)
  })

  test('a web_search request goes to the first route that can run the tool', async () => {
    __setTierProfilesForTests({
      live: mapWith({ sonnet: [sonnetRoute({ hostsWebSearch: false }), codexRoute()] })
    })
    const req = await run({ body: { tools: [{ type: 'web_search_20250305', name: 'web_search' }] } })
    expect(req.body.model).toBe(CODEX)
    expect(req.resolvedFallbacks).toEqual([])
  })

  test('a prompt too big for a route goes to the next that can hold it', async () => {
    __setTierProfilesForTests({
      live: mapWith({ sonnet: [sonnetRoute({ contextWindow: 50 }), codexRoute({ contextWindow: 400_000 })] })
    })
    const req = await run({ body: { messages: [{ role: 'user', content: 'lorem ipsum dolor sit amet '.repeat(50) }] } })
    expect(req.tokenCount).toBeGreaterThan(50)
    expect(req.body.model).toBe(CODEX)
  })

  test('the subagent tag is stripped and recorded, but picks no lane of its own', async () => {
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute(), codexRoute()] }) })
    const req = await run({ body: { system: subagentSystem() } })
    expect(req.isSubagent).toBe(true)
    // The same routes a main-agent request of this tier gets.
    expect(req.body.model).toBe(SONNET)
    expect(req.resolvedFallbacks).toEqual([CODEX])
    expect(textOf(req.body.system, 1)).toBe('')
  })

  test('the pre-rename <CCR-SUBAGENT-MODEL> tag is still recognised and stripped', async () => {
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute()] }) })
    const system = [
      { type: 'text', text: 'preamble' },
      { type: 'text', text: '<CCR-SUBAGENT-MODEL>x,y</CCR-SUBAGENT-MODEL>' }
    ]
    const req = await run({ body: { system } })
    expect(req.isSubagent).toBe(true)
    expect(textOf(req.body.system, 1)).toBe('')
  })
})

describe('disabled targets never reach the caller', () => {
  test('a switched-off route or target is neither the primary nor a fallback', async () => {
    __setTierProfilesForTests({
      live: mapWith({
        sonnet: [
          sonnetRoute({ enabled: false }),
          route('claude-code', 'opus', 'claude-opus-4-7', { targetEnabled: false }),
          codexRoute()
        ]
      })
    })
    const req = await run()
    expect(req.body.model).toBe(CODEX)
    expect(req.resolvedFallbacks).toEqual([])
  })

  test('a switched-off fallback is dropped from the chain the failover paths walk', async () => {
    __setTierProfilesForTests({
      live: mapWith({
        sonnet: [sonnetRoute(), route('claude-code', 'opus', 'claude-opus-4-7', { enabled: false }), codexRoute()]
      })
    })
    const req = await run()
    expect(req.body.model).toBe(SONNET)
    expect(req.resolvedFallbacks).toEqual([CODEX])
  })
})

describe('the map has nothing for this request — the caller keeps its own model', () => {
  test('a tier with no routes passes through, never a 429, whatever exhaustedBehavior says', async () => {
    // "Nothing configured" is not "everything exhausted". Other tiers
    // having routes does not matter: there is no implicit substitution.
    __setTierProfilesForTests({
      live: mapWith({ opus: [route('claude-code', 'opus', 'claude-opus-4-7')] }, { exhaustedBehavior: '429' })
    })
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.route).toBe(PASSTHROUGH_ROUTE)
    expect(req.quotaExhaustedRetryAfterSec).toBeUndefined()
    expect(req.routingRefusal).toBeUndefined()
  })

  test('a model that names no family asks for "other", which passes through when empty', async () => {
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute()] }) })
    const req = await run({ model: 'caller,own-model' })
    expect(req.body.model).toBe('caller,own-model')
    expect(req.route).toBe(PASSTHROUGH_ROUTE)
  })

  test('a profile with no stored map reads as empty and passes through', async () => {
    const req = await run({ profileKeyOverride: 'never-saved' })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.route).toBe(PASSTHROUGH_ROUTE)
  })

  test('every route or target switched off passes through like an empty tier, even under 429', async () => {
    __setTierProfilesForTests({
      live: mapWith(
        { sonnet: [sonnetRoute({ enabled: false }), codexRoute({ targetEnabled: false })] },
        { exhaustedBehavior: '429' }
      )
    })
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.route).toBe(PASSTHROUGH_ROUTE)
    expect(req.quotaExhaustedRetryAfterSec).toBeUndefined()
    expect(req.routingRefusal).toBeUndefined()
  })

  test('every route held on quota under 429 stamps a Retry-After and rewrites nothing', async () => {
    __setTierProfilesForTests({
      live: mapWith({ sonnet: [sonnetRoute(), codexRoute()] }, { exhaustedBehavior: '429' })
    })
    // The Retry-After is the first held route's own deadline: the 429
    // mark's where one was set.
    markModelExhausted('claude-code', 'claude-sonnet-5', dayjs().add(90, 'second').valueOf())
    markModelExhausted('codex', 'gpt-5.5', dayjs().add(10, 'minute').valueOf())
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    // Stamped with the tier that could not be served, not 'passthrough':
    // the request log should say what was asked for.
    expect(req.route).toBe('sonnet')
    expect(req.quotaExhaustedRetryAfterSec).toBeGreaterThanOrEqual(89)
    expect(req.quotaExhaustedRetryAfterSec).toBeLessThanOrEqual(90)
    expect(req.routingRefusal).toBeUndefined()
  })

  test('with no 429 mark, the Retry-After comes from the snapshot reset', async () => {
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute()] }, { exhaustedBehavior: '429' }) })
    publishQuota({
      [SONNET]: { exhausted: true, remainingBudgetPct: 0, resetAt: dayjs().add(120, 'second').valueOf() }
    })
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.quotaExhaustedRetryAfterSec).toBeGreaterThanOrEqual(119)
    expect(req.quotaExhaustedRetryAfterSec).toBeLessThanOrEqual(120)
  })

  test('held on health alone, the Retry-After is the default 30 s', async () => {
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute()] }, { exhaustedBehavior: '429' }) })
    failRepeatedly(SONNET)
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.quotaExhaustedRetryAfterSec).toBe(30)
  })

  test('every route held under exhaustedBehavior passthrough leaves body.model untouched', async () => {
    __setTierProfilesForTests({
      live: mapWith({ sonnet: [sonnetRoute(), codexRoute()] }, { exhaustedBehavior: 'passthrough' })
    })
    markModelExhausted('claude-code', 'claude-sonnet-5')
    failRepeatedly(CODEX)
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.route).toBe(PASSTHROUGH_ROUTE)
    expect(req.quotaExhaustedRetryAfterSec).toBeUndefined()
    expect(req.routingRefusal).toBeUndefined()
  })
})

describe('a configured map that cannot take this request refuses it', () => {
  test('an unset alias on every route is refused, not passed through', async () => {
    __setTierProfilesForTests({ live: mapWith({ sonnet: [route('claude-code', 'sonnet', null)] }) })
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.route).toBe('sonnet')
    expect(req.routingRefusal).toContain('no model aliased')
    expect(req.quotaExhaustedRetryAfterSec).toBeUndefined()
  })

  test('a web_search request no route can run is refused', async () => {
    __setTierProfilesForTests({
      live: mapWith({ sonnet: [sonnetRoute({ hostsWebSearch: false }), codexRoute({ hostsWebSearch: false })] })
    })
    const req = await run({ body: { tools: [{ type: 'web_search_20250305', name: 'web_search' }] } })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.routingRefusal).toContain('web_search')
  })

  test('a prompt no route can hold is refused', async () => {
    __setTierProfilesForTests({
      live: mapWith({ sonnet: [sonnetRoute({ contextWindow: 50 }), codexRoute({ contextWindow: 50 })] })
    })
    const req = await run({ body: { messages: [{ role: 'user', content: 'lorem ipsum dolor sit amet '.repeat(50) }] } })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.routingRefusal).toContain('context window')
  })

  test('exhaustedBehavior passthrough does not soften a refusal', async () => {
    // Passthrough is what to do while waiting for quota; a refusal is
    // not something waiting fixes.
    __setTierProfilesForTests({
      live: mapWith({ sonnet: [route('claude-code', 'sonnet', null)] }, { exhaustedBehavior: 'passthrough' })
    })
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.routingRefusal).toBeDefined()
  })

  test('a route held on quota beside a refused one makes it exhaustion, not a refusal', async () => {
    // Waiting would bring the held route back, so the answer is the 429.
    __setTierProfilesForTests({
      live: mapWith({ sonnet: [sonnetRoute(), route('codex', 'sonnet', null)] }, { exhaustedBehavior: '429' })
    })
    markModelExhausted('claude-code', 'claude-sonnet-5')
    const req = await run()
    expect(req.routingRefusal).toBeUndefined()
    expect(req.quotaExhaustedRetryAfterSec).toBeGreaterThan(0)
  })
})

describe('the map cannot be consulted', () => {
  const errorLines = () => logged.lines.filter((line) => line.includes('"level":50'))

  test('a map that fails to load leaves body.model untouched, and says so', async () => {
    __setTierProfilesForTests({ live: new Error('database is away') })
    const req = await run({ body: { system: subagentSystem() } })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.route).toBe(PASSTHROUGH_ROUTE)
    expect(errorLines().some((line) => line.includes('database is away'))).toBe(true)
    // The flag is still read off the tag, and the tag still stripped.
    expect(req.isSubagent).toBe(true)
    expect(textOf(req.body.system, 1)).toBe('')
  })

  test('routing throwing before the map is reached leaves body.model untouched', async () => {
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute()] }) })
    // A registry that was never initialised throws on the first count —
    // the tokenizer being away, without a stub standing in for it.
    const req = await run({ tokenizers: new TokenizerRegistry() })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.route).toBe(PASSTHROUGH_ROUTE)
    expect(req.isSubagent).toBe(false)
    expect(errorLines()).toHaveLength(1)
  })
})

describe('passthrough', () => {
  test('a token naming the reserved passthrough profile skips the map on a routed surface', async () => {
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute()] }) })
    const req = await run({ profileKeyOverride: PASSTHROUGH_PROFILE_KEY })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.route).toBe(PASSTHROUGH_ROUTE)
    // Nothing was counted: the map was never asked.
    expect(req.tokenCount).toBeUndefined()
  })

  test('a passthrough surface skips the map even when it has a route', async () => {
    __setSurfacesForTests({ 'anthropic-messages': 'passthrough' })
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute()] }) })
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.route).toBe(PASSTHROUGH_ROUTE)
    expect(req.tokenCount).toBeUndefined()
  })

  test('a quota-held tier is not a 429 on a passthrough surface', async () => {
    __setSurfacesForTests({ 'anthropic-messages': 'passthrough' })
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute()] }, { exhaustedBehavior: '429' }) })
    markModelExhausted('claude-code', 'claude-sonnet-5')
    const req = await run()
    expect(req.quotaExhaustedRetryAfterSec).toBeUndefined()
  })
})

describe('the persona rides on every routed /v1/messages exit', () => {
  test('when a route served the request', async () => {
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute()] }) })
    const req = await run({ ActivePersona: 'p1' })
    expect(req.body.system).toBe('You are terse.')
  })

  test('when the tier had no route', async () => {
    const req = await run({ ActivePersona: 'p1' })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.body.system).toBe('You are terse.')
  })

  test('when the map failed to load', async () => {
    __setTierProfilesForTests({ live: new Error('database is away') })
    const req = await run({ ActivePersona: 'p1' })
    expect(req.body.system).toBe('You are terse.')
  })

  test('not on a passthrough surface, which gets exactly what it sent', async () => {
    __setSurfacesForTests({ 'anthropic-messages': 'passthrough' })
    const req = await run({ ActivePersona: 'p1' })
    expect(req.body.system).toBeUndefined()
  })
})
