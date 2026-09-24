/**
 * `routeRequest` end to end, with the scenario routes seeded in place of
 * the database.
 *
 * The contract under test is the one the Routing screen describes. A
 * routed surface classifies the request, then walks that scenario and
 * lane's list of provider · tier routes in order:
 *
 *   | the request                              | scenario    |
 *   |------------------------------------------|-------------|
 *   | input over the Long context threshold    | longContext |
 *   | otherwise, thinking on                   | think       |
 *   | otherwise                                | default     |
 *
 * and the lane is `subagent` when the subagent tag was present, `agent`
 * otherwise. The model name the caller sent picks nothing. A scenario
 * whose list has no usable route (on, resolving to a model that is on)
 * falls back to Default in the same lane; an empty Default passes the
 * request through. The routes that pass their gates are ordered by pace.
 *
 * When the list has nothing for the request, what happens depends on why:
 *
 *   | the list's routes                          | body.model | answer                    |
 *   |--------------------------------------------|------------|---------------------------|
 *   | none, in Default too                       | untouched  | upstream as sent, no 429  |
 *   | every route or target switched off         | untouched  | upstream as sent, no 429  |
 *   | every route held on quota / health, '429'  | untouched  | 429 + Retry-After         |
 *   | the same under 'passthrough'               | untouched  | upstream as sent          |
 *   | configured, but none can take THIS request | untouched  | 400 (routingRefusal)      |
 *   | the map fails to load / routing throws     | untouched  | upstream as sent, logged  |
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

// What Claude Code sends: a bare model name. It no longer picks a route.
const CALLER_MODEL = 'claude-sonnet-4-5'
const SONNET = 'claude-code,claude-sonnet-5'
const CODEX = 'codex,gpt-5.5'
const OPUS = 'claude-code,claude-opus-4-7'
const LONG = 'google,gemini-3-pro'

type Over = Parameters<typeof route>[3]
const sonnetRoute = (over: Over = {}) => route('claude-code', 'sonnet', 'claude-sonnet-5', over)
const codexRoute = (over: Over = {}) => route('codex', 'sonnet', 'gpt-5.5', over)
const opusRoute = (over: Over = {}) => route('claude-code', 'opus', 'claude-opus-4-7', over)
const longRoute = (over: Over = {}) => route('google', 'sonnet', 'gemini-3-pro', over)

// The common shape: routes in the Default list of the agent lane only.
const onDefault = (routes: ReturnType<typeof route>[], constraints: Parameters<typeof mapWith>[1] = {}) =>
  mapWith({ default: { agent: routes } }, constraints)

// A map where every scenario and lane leads somewhere different, so the
// target alone names the list the request walked.
const everyList = () =>
  mapWith({
    default: { agent: [sonnetRoute()], subagent: [codexRoute()] },
    think: { agent: [opusRoute()], subagent: [route('codex', 'opus', 'gpt-5.5-pro')] },
    longContext: { agent: [longRoute()], subagent: [route('google', 'haiku', 'gemini-3-flash')] }
  })

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

const THINKING = { thinking: { type: 'enabled', budget_tokens: 4096 } }

const subagentSystem = (tag = 'RIALTO-SUBAGENT-MODEL') => [
  { type: 'text', text: 'preamble' },
  { type: 'text', text: `<${tag}>anything</${tag}>` }
]

const textOf = (system: RouterRequestBody['system'], index: number): string | undefined => {
  const text = Array.isArray(system) ? system[index]?.text : undefined
  return typeof text === 'string' ? text : undefined
}

// A prompt of some 1,500 tokens, and its size as the router counts it.
// The windows below are set relative to that count rather than to one
// tokenizer's exact output.
const LONG_BODY = { messages: [{ role: 'user', content: 'lorem ipsum dolor sit amet '.repeat(300) }] }
async function tokensOf(body: Record<string, unknown>): Promise<number> {
  const req = await run({ body, profileKeyOverride: 'never-saved' })
  if (req.tokenCount === undefined) throw new Error('the router did not count the prompt')
  return req.tokenCount
}
// A Default · agent window whose automatic threshold (70% of it) lands
// just under, or just over, `tokens`. Either way the window itself holds
// the prompt, so the context gate does not decide instead.
const windowPuttingThresholdBelow = (tokens: number): number => Math.floor(tokens / 0.7) - 10
const windowPuttingThresholdAbove = (tokens: number): number => Math.ceil(tokens / 0.7) + 10

// One scheduler tick's worth of readings, keyed by target. Unnamed fields
// read as "nothing known", which holds no route and orders none.
type Reading = Partial<Omit<TargetQuotaState, 'target'>>
const publishQuota = (targets: Record<string, Reading>): void => {
  publishSnapshot({
    tickAt: dayjs().valueOf(),
    tickCount: 1,
    consecutiveFailures: 0,
    degraded: false,
    targets: new Map(
      Object.entries(targets).map(([target, reading]) => [
        target,
        { target, exhausted: false, remainingBudgetPct: null, projectedPct: null, resetAt: null, ...reading }
      ])
    ),
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
  clearModelExhaustion('claude-code', 'claude-opus-4-7')
  clearModelExhaustion('codex', 'gpt-5.5')
  clearModelExhaustion('google', 'gemini-3-pro')
  clearProviderExhaustion('claude-code')
  clearProviderExhaustion('codex')
  clearProviderExhaustion('google')
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

describe('the scenario comes from the request', () => {
  test('an ordinary request walks Default: the first route that passes is the target, the rest fall back', async () => {
    __setTierProfilesForTests({ live: mapWith({ default: { agent: [sonnetRoute(), codexRoute()] } }) })
    const req = await run()
    expect(req.body.model).toBe(SONNET)
    expect(req.resolvedFallbacks).toEqual([CODEX])
    expect(req.route).toBe('default')
    expect(req.isSubagent).toBe(false)
    expect(typeof req.tokenCount).toBe('number')
    expect(req.quotaExhaustedRetryAfterSec).toBeUndefined()
    expect(req.routingRefusal).toBeUndefined()
  })

  test('thinking on walks the Think list', async () => {
    __setTierProfilesForTests({ live: everyList() })
    const req = await run({ body: THINKING })
    expect(req.body.model).toBe(OPUS)
    expect(req.route).toBe('think')
  })

  test('adaptive thinking counts; thinking switched off does not', async () => {
    __setTierProfilesForTests({ live: everyList() })
    const adaptive = await run({ body: { thinking: { type: 'adaptive' } } })
    expect(adaptive.route).toBe('think')
    const disabled = await run({ body: { thinking: { type: 'disabled' } } })
    expect(disabled.body.model).toBe(SONNET)
    expect(disabled.route).toBe('default')
  })

  test('input over the Long context threshold walks the Long context list', async () => {
    const tokens = await tokensOf(LONG_BODY)
    __setTierProfilesForTests({
      live: mapWith({
        default: { agent: [sonnetRoute({ contextWindow: windowPuttingThresholdBelow(tokens) })] },
        longContext: { agent: [longRoute()] }
      })
    })
    const req = await run({ body: LONG_BODY })
    expect(req.body.model).toBe(LONG)
    expect(req.route).toBe('longContext')
  })

  test('long input wins over thinking: a long prompt is Long context whether or not it asks to think', async () => {
    const tokens = await tokensOf(LONG_BODY)
    __setTierProfilesForTests({
      live: mapWith({
        default: { agent: [sonnetRoute({ contextWindow: windowPuttingThresholdBelow(tokens) })] },
        think: { agent: [opusRoute()] },
        longContext: { agent: [longRoute()] }
      })
    })
    const req = await run({ body: { ...LONG_BODY, ...THINKING } })
    expect(req.body.model).toBe(LONG)
    expect(req.route).toBe('longContext')
  })

  test("the threshold is 70% of the Default · agent route's context window", async () => {
    const tokens = await tokensOf(LONG_BODY)
    const withDefaultWindow = (contextWindow: number) =>
      mapWith({
        default: { agent: [sonnetRoute({ contextWindow })] },
        longContext: { agent: [longRoute()] }
      })
    __setTierProfilesForTests({ live: withDefaultWindow(windowPuttingThresholdBelow(tokens)) })
    expect((await run({ body: LONG_BODY })).route).toBe('longContext')
    __setTierProfilesForTests({ live: withDefaultWindow(windowPuttingThresholdAbove(tokens)) })
    const fits = await run({ body: LONG_BODY })
    expect(fits.route).toBe('default')
    expect(fits.body.model).toBe(SONNET)
  })

  test('the threshold reads the first usable Default · agent route, not one switched off above it', async () => {
    // A switched-off route cannot take the traffic, so its window says
    // nothing about what the Default model can hold.
    const tokens = await tokensOf(LONG_BODY)
    __setTierProfilesForTests({
      live: mapWith({
        default: {
          agent: [
            sonnetRoute({ enabled: false, contextWindow: windowPuttingThresholdAbove(tokens) }),
            codexRoute({ contextWindow: windowPuttingThresholdBelow(tokens) })
          ]
        },
        longContext: { agent: [longRoute()] }
      })
    })
    expect((await run({ body: LONG_BODY })).route).toBe('longContext')
  })

  test('a tuned threshold is never above the base: past it the Default model could not hold the prompt', async () => {
    const tokens = await tokensOf(LONG_BODY)
    __setTierProfilesForTests({
      live: mapWith(
        {
          default: { agent: [sonnetRoute({ contextWindow: windowPuttingThresholdBelow(tokens) })] },
          longContext: { agent: [longRoute()] }
        },
        { longContextThreshold: 900_000 }
      )
    })
    expect((await run({ body: LONG_BODY })).route).toBe('longContext')
  })

  test('the model name the caller sent picks nothing', async () => {
    __setTierProfilesForTests({ live: everyList() })
    for (const model of ['claude-opus-4-7', 'claude-haiku-4-5', 'anthropic,claude-fable-5', 'gpt-5', 'caller,own']) {
      const req = await run({ model })
      expect(req.body.model).toBe(SONNET)
      expect(req.route).toBe('default')
    }
  })
})

describe('the lane comes from the subagent tag', () => {
  test('a tagged request walks the subagent list, and the tag is stripped', async () => {
    __setTierProfilesForTests({ live: everyList() })
    const req = await run({ body: { system: subagentSystem() } })
    expect(req.isSubagent).toBe(true)
    expect(req.body.model).toBe(CODEX)
    expect(req.route).toBe('default')
    expect(textOf(req.body.system, 1)).toBe('')
  })

  test('the pre-rename <CCR-SUBAGENT-MODEL> tag picks the subagent lane too, and is stripped', async () => {
    __setTierProfilesForTests({ live: everyList() })
    const req = await run({ body: { system: subagentSystem('CCR-SUBAGENT-MODEL') } })
    expect(req.isSubagent).toBe(true)
    expect(req.body.model).toBe(CODEX)
    expect(textOf(req.body.system, 1)).toBe('')
  })

  test('the lane and the scenario combine: a thinking subagent walks Think · subagent', async () => {
    __setTierProfilesForTests({ live: everyList() })
    const req = await run({ body: { system: subagentSystem(), ...THINKING } })
    expect(req.body.model).toBe('codex,gpt-5.5-pro')
    expect(req.route).toBe('think')
    expect(req.isSubagent).toBe(true)
  })

  test('an untagged request never reads the subagent list', async () => {
    __setTierProfilesForTests({ live: mapWith({ default: { subagent: [codexRoute()] } }) })
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.route).toBe(PASSTHROUGH_ROUTE)
  })

  test('a tagged request with no subagent routes passes through rather than borrowing the agent list', async () => {
    // Each lane is its own configuration; the subagent lane being empty
    // is "no opinion" for subagents, not "route them as the main agent".
    __setTierProfilesForTests({ live: onDefault([sonnetRoute()]) })
    const req = await run({ body: { system: subagentSystem() } })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.route).toBe(PASSTHROUGH_ROUTE)
    expect(req.isSubagent).toBe(true)
    expect(textOf(req.body.system, 1)).toBe('')
  })
})

describe('a scenario with nothing usable falls back to Default in the same lane', () => {
  test('an empty Think list falls back to Default', async () => {
    __setTierProfilesForTests({ live: onDefault([sonnetRoute(), codexRoute()]) })
    const req = await run({ body: THINKING })
    expect(req.body.model).toBe(SONNET)
    expect(req.resolvedFallbacks).toEqual([CODEX])
    expect(req.route).toBe('default')
  })

  test('so does a Think list whose routes are all off, point at a model that is off, or have no alias', async () => {
    // None of these could serve anything, so the list is treated as not
    // configured. An unset alias in Default is a refusal (below); in a
    // scenario that has Default to fall back on, it is not a reason to
    // turn the request away.
    for (const think of [
      [opusRoute({ enabled: false })],
      [opusRoute({ targetEnabled: false })],
      [route('claude-code', 'opus', null)]
    ]) {
      __setTierProfilesForTests({ live: mapWith({ default: { agent: [sonnetRoute()] }, think: { agent: think } }) })
      const req = await run({ body: THINKING })
      expect(req.body.model).toBe(SONNET)
      expect(req.route).toBe('default')
    }
  })

  test('an empty Long context list falls back to Default, which still gates on its window', async () => {
    const tokens = await tokensOf(LONG_BODY)
    __setTierProfilesForTests({
      live: onDefault([sonnetRoute({ contextWindow: windowPuttingThresholdBelow(tokens) })])
    })
    const req = await run({ body: LONG_BODY })
    expect(req.body.model).toBe(SONNET)
    expect(req.route).toBe('default')
  })

  test('the fallback stays in the lane: Think · subagent empty goes to Default · subagent', async () => {
    __setTierProfilesForTests({
      live: mapWith({ default: { agent: [sonnetRoute()], subagent: [codexRoute()] }, think: { agent: [opusRoute()] } })
    })
    const req = await run({ body: { system: subagentSystem(), ...THINKING } })
    expect(req.body.model).toBe(CODEX)
    expect(req.route).toBe('default')
  })

  test('a Think list held on quota is a 429 for Think, not a fall back to Default', async () => {
    // The fallback is for lists with nothing configured. A list that is
    // configured but out of quota answers as its profile says, or the
    // Default models would take all of Think's traffic whenever it runs dry.
    __setTierProfilesForTests({
      live: mapWith({ default: { agent: [sonnetRoute()] }, think: { agent: [opusRoute()] } })
    })
    markModelExhausted('claude-code', 'claude-opus-4-7', dayjs().add(60, 'second').valueOf())
    const req = await run({ body: THINKING })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.route).toBe('think')
    expect(req.quotaExhaustedRetryAfterSec).toBeGreaterThan(0)
  })

  test('an empty Default passes through, whatever the other lists hold', async () => {
    __setTierProfilesForTests({
      live: mapWith(
        { think: { agent: [opusRoute()], subagent: [opusRoute()] }, longContext: { agent: [longRoute()] } },
        { exhaustedBehavior: '429' }
      )
    })
    const plain = await run()
    expect(plain.body.model).toBe(CALLER_MODEL)
    expect(plain.route).toBe(PASSTHROUGH_ROUTE)
    expect(plain.resolvedFallbacks).toEqual([])
    expect(plain.quotaExhaustedRetryAfterSec).toBeUndefined()
    expect(plain.routingRefusal).toBeUndefined()
  })
})

describe('pace orders the routes that pass', () => {
  const paceLines = () => logged.lines.filter((line) => line.includes('pace reordered'))

  beforeEach(() => {
    __setTierProfilesForTests({ live: onDefault([sonnetRoute(), codexRoute(), opusRoute()]) })
  })

  test('a route on course to run out steps down behind the rest', async () => {
    publishQuota({ [SONNET]: { projectedPct: 130 }, [OPUS]: { projectedPct: 80 } })
    const req = await run()
    expect(req.body.model).toBe(CODEX)
    expect(req.resolvedFallbacks).toEqual([OPUS, SONNET])
    expect(paceLines()).toHaveLength(1)
  })

  test('a route with quota to spare is pulled to the front', async () => {
    publishQuota({ [SONNET]: { projectedPct: 90 }, [OPUS]: { projectedPct: 20 } })
    const req = await run()
    expect(req.body.model).toBe(OPUS)
    expect(req.resolvedFallbacks).toEqual([SONNET, CODEX])
    expect(paceLines()).toHaveLength(1)
  })

  test('both at once: surplus first, then the rest in list order, then the over-pace', async () => {
    publishQuota({ [SONNET]: { projectedPct: 120 }, [CODEX]: { projectedPct: 70 }, [OPUS]: { projectedPct: 10 } })
    const req = await run()
    expect([req.body.model, ...(req.resolvedFallbacks === undefined ? [] : req.resolvedFallbacks)]).toEqual([
      OPUS,
      CODEX,
      SONNET
    ])
  })

  test('every route over pace keeps list order: a projection alone never refuses a request', async () => {
    publishQuota({
      [SONNET]: { projectedPct: 150 },
      [CODEX]: { projectedPct: 140 },
      [OPUS]: { projectedPct: 101 }
    })
    const req = await run()
    expect(req.body.model).toBe(SONNET)
    expect(req.resolvedFallbacks).toEqual([CODEX, OPUS])
    expect(req.quotaExhaustedRetryAfterSec).toBeUndefined()
    expect(paceLines()).toEqual([])
  })

  test('on pace, or no reading yet, keeps list order and logs nothing', async () => {
    publishQuota({ [SONNET]: { projectedPct: 100 }, [CODEX]: { projectedPct: 60 } })
    const req = await run()
    expect(req.body.model).toBe(SONNET)
    expect(req.resolvedFallbacks).toEqual([CODEX, OPUS])
    expect(paceLines()).toEqual([])
  })

  test('pace never brings back a route a gate held', async () => {
    publishQuota({ [OPUS]: { projectedPct: 5, exhausted: true, remainingBudgetPct: 0 } })
    const req = await run()
    expect(req.body.model).toBe(SONNET)
    expect(req.resolvedFallbacks).toEqual([CODEX])
  })

  test('pace orders the list the request was classified into', async () => {
    __setTierProfilesForTests({
      live: mapWith({ default: { agent: [sonnetRoute()] }, think: { agent: [opusRoute(), codexRoute()] } })
    })
    publishQuota({ [OPUS]: { projectedPct: 110 } })
    const req = await run({ body: THINKING })
    expect(req.route).toBe('think')
    expect(req.body.model).toBe(CODEX)
    expect(req.resolvedFallbacks).toEqual([OPUS])
  })
})

describe('the gates skip a route that cannot take this request', () => {
  test('a token-level profile wins over the surface profile', async () => {
    __setTierProfilesForTests({
      live: onDefault([sonnetRoute()]),
      'cost-first': mapWith({ default: { agent: [codexRoute()] } }, {}, 'cost-first')
    })
    const req = await run({ profileKeyOverride: 'cost-first' })
    expect(req.body.model).toBe(CODEX)
  })

  test('a route marked exhausted by a 429 is skipped for the next', async () => {
    __setTierProfilesForTests({ live: onDefault([sonnetRoute(), codexRoute()]) })
    markModelExhausted('claude-code', 'claude-sonnet-5')
    expect((await run()).body.model).toBe(CODEX)
  })

  test('a provider-wide mark holds every route on that provider', async () => {
    __setTierProfilesForTests({ live: onDefault([sonnetRoute(), opusRoute(), codexRoute()]) })
    markProviderExhausted('claude-code')
    const req = await run()
    expect(req.body.model).toBe(CODEX)
    expect(req.resolvedFallbacks).toEqual([])
  })

  test('a route the quota snapshot reads as spent is skipped', async () => {
    __setTierProfilesForTests({ live: onDefault([sonnetRoute(), codexRoute()]) })
    publishQuota({ [SONNET]: { exhausted: true, remainingBudgetPct: 0, resetAt: dayjs().add(1, 'hour').valueOf() } })
    expect((await run()).body.model).toBe(CODEX)
  })

  test('quotaSkipPct holds a route used at or past it, and only then', async () => {
    __setTierProfilesForTests({ live: onDefault([sonnetRoute(), codexRoute()], { quotaSkipPct: 80 }) })
    publishQuota({ [SONNET]: { remainingBudgetPct: 15 } })
    expect((await run()).body.model).toBe(CODEX)
    publishQuota({ [SONNET]: { remainingBudgetPct: 25 } })
    expect((await run()).body.model).toBe(SONNET)
  })

  test('a target the snapshot has never seen is not held on quota', async () => {
    // api_key providers have no quota the scheduler reads; the upstream's
    // own 429 is the judge for them.
    __setTierProfilesForTests({ live: onDefault([sonnetRoute(), codexRoute()]) })
    publishQuota({ [CODEX]: { exhausted: true, remainingBudgetPct: 0 } })
    expect((await run()).body.model).toBe(SONNET)
  })

  test('a failing route is skipped once it has enough samples, not before', async () => {
    __setTierProfilesForTests({ live: onDefault([sonnetRoute(), codexRoute()]) })
    failRepeatedly(SONNET, 4)
    expect((await run()).body.model).toBe(SONNET)
    recordModelFailure(SONNET)
    expect((await run()).body.model).toBe(CODEX)
  })

  test('a web_search request goes to the first route that can run the tool', async () => {
    __setTierProfilesForTests({ live: onDefault([sonnetRoute({ hostsWebSearch: false }), codexRoute()]) })
    const req = await run({ body: { tools: [{ type: 'web_search_20250305', name: 'web_search' }] } })
    expect(req.body.model).toBe(CODEX)
    expect(req.resolvedFallbacks).toEqual([])
  })

  test('a prompt too big for a route goes to the next that can hold it', async () => {
    // The first route's window also sets the Long context threshold; with
    // no Long context list the request stays on Default and meets the gate.
    __setTierProfilesForTests({
      live: onDefault([sonnetRoute({ contextWindow: 50 }), codexRoute({ contextWindow: 400_000 })])
    })
    const req = await run({ body: { messages: [{ role: 'user', content: 'lorem ipsum dolor sit amet '.repeat(50) }] } })
    expect(req.tokenCount).toBeGreaterThan(50)
    expect(req.body.model).toBe(CODEX)
  })
})

describe('disabled targets never reach the caller', () => {
  test('a switched-off route or target is neither the primary nor a fallback', async () => {
    __setTierProfilesForTests({
      live: onDefault([sonnetRoute({ enabled: false }), opusRoute({ targetEnabled: false }), codexRoute()])
    })
    const req = await run()
    expect(req.body.model).toBe(CODEX)
    expect(req.resolvedFallbacks).toEqual([])
  })

  test('a switched-off fallback is dropped from the chain the failover paths walk', async () => {
    __setTierProfilesForTests({ live: onDefault([sonnetRoute(), opusRoute({ enabled: false }), codexRoute()]) })
    const req = await run()
    expect(req.body.model).toBe(SONNET)
    expect(req.resolvedFallbacks).toEqual([CODEX])
  })
})

describe('the list has nothing for this request — the caller keeps its own model', () => {
  test('an empty map passes through, never a 429, whatever exhaustedBehavior says', async () => {
    // "Nothing configured" is not "everything exhausted".
    __setTierProfilesForTests({ live: mapWith({}, { exhaustedBehavior: '429' }) })
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.route).toBe(PASSTHROUGH_ROUTE)
    expect(req.quotaExhaustedRetryAfterSec).toBeUndefined()
    expect(req.routingRefusal).toBeUndefined()
  })

  test('a profile with no stored map reads as empty and passes through', async () => {
    const req = await run({ profileKeyOverride: 'never-saved' })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.route).toBe(PASSTHROUGH_ROUTE)
  })

  test('every route or target switched off passes through like an empty list, even under 429', async () => {
    __setTierProfilesForTests({
      live: onDefault([sonnetRoute({ enabled: false }), codexRoute({ targetEnabled: false })], {
        exhaustedBehavior: '429'
      })
    })
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.route).toBe(PASSTHROUGH_ROUTE)
    expect(req.quotaExhaustedRetryAfterSec).toBeUndefined()
    expect(req.routingRefusal).toBeUndefined()
  })

  test('every route held on quota under 429 stamps a Retry-After and rewrites nothing', async () => {
    __setTierProfilesForTests({ live: onDefault([sonnetRoute(), codexRoute()], { exhaustedBehavior: '429' }) })
    // The Retry-After is the first held route's own deadline: the 429
    // mark's where one was set.
    markModelExhausted('claude-code', 'claude-sonnet-5', dayjs().add(90, 'second').valueOf())
    markModelExhausted('codex', 'gpt-5.5', dayjs().add(10, 'minute').valueOf())
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    // Stamped with the scenario that could not be served, not
    // 'passthrough': the request log should say what the request was.
    expect(req.route).toBe('default')
    expect(req.quotaExhaustedRetryAfterSec).toBeGreaterThanOrEqual(89)
    expect(req.quotaExhaustedRetryAfterSec).toBeLessThanOrEqual(90)
    expect(req.routingRefusal).toBeUndefined()
  })

  test('with no 429 mark, the Retry-After comes from the snapshot reset', async () => {
    __setTierProfilesForTests({ live: onDefault([sonnetRoute()], { exhaustedBehavior: '429' }) })
    publishQuota({
      [SONNET]: { exhausted: true, remainingBudgetPct: 0, resetAt: dayjs().add(120, 'second').valueOf() }
    })
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.quotaExhaustedRetryAfterSec).toBeGreaterThanOrEqual(119)
    expect(req.quotaExhaustedRetryAfterSec).toBeLessThanOrEqual(120)
  })

  test('held on health alone, the Retry-After is the default 30 s', async () => {
    __setTierProfilesForTests({ live: onDefault([sonnetRoute()], { exhaustedBehavior: '429' }) })
    failRepeatedly(SONNET)
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.quotaExhaustedRetryAfterSec).toBe(30)
  })

  test('every route held under exhaustedBehavior passthrough leaves body.model untouched', async () => {
    __setTierProfilesForTests({
      live: onDefault([sonnetRoute(), codexRoute()], { exhaustedBehavior: 'passthrough' })
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

describe('a configured list that cannot take this request refuses it', () => {
  test('an unset alias on every route is refused, not passed through', async () => {
    __setTierProfilesForTests({ live: onDefault([route('claude-code', 'sonnet', null)]) })
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.route).toBe('default')
    expect(req.routingRefusal).toContain('no model aliased')
    expect(req.quotaExhaustedRetryAfterSec).toBeUndefined()
  })

  test('a web_search request no route can run is refused', async () => {
    __setTierProfilesForTests({
      live: onDefault([sonnetRoute({ hostsWebSearch: false }), codexRoute({ hostsWebSearch: false })])
    })
    const req = await run({ body: { tools: [{ type: 'web_search_20250305', name: 'web_search' }] } })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.routingRefusal).toContain('web_search')
  })

  test('a prompt no route can hold is refused', async () => {
    __setTierProfilesForTests({
      live: onDefault([sonnetRoute({ contextWindow: 50 }), codexRoute({ contextWindow: 50 })])
    })
    const req = await run({ body: { messages: [{ role: 'user', content: 'lorem ipsum dolor sit amet '.repeat(50) }] } })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.routingRefusal).toContain('context window')
  })

  test('a Long context list too small for the prompt refuses it rather than falling back', async () => {
    // The list is configured and usable; it just cannot take this prompt.
    const tokens = await tokensOf(LONG_BODY)
    __setTierProfilesForTests({
      live: mapWith({
        default: { agent: [sonnetRoute({ contextWindow: windowPuttingThresholdBelow(tokens) })] },
        longContext: { agent: [longRoute({ contextWindow: 100 })] }
      })
    })
    const req = await run({ body: LONG_BODY })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.route).toBe('longContext')
    expect(req.routingRefusal).toContain('context window')
  })

  test('exhaustedBehavior passthrough does not soften a refusal', async () => {
    // Passthrough is what to do while waiting for quota; a refusal is
    // not something waiting fixes.
    __setTierProfilesForTests({
      live: onDefault([route('claude-code', 'sonnet', null)], { exhaustedBehavior: 'passthrough' })
    })
    const req = await run()
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.routingRefusal).toBeDefined()
  })

  test('a route held on quota beside a refused one makes it exhaustion, not a refusal', async () => {
    // Waiting would bring the held route back, so the answer is the 429.
    __setTierProfilesForTests({
      live: onDefault([sonnetRoute(), route('codex', 'sonnet', null)], { exhaustedBehavior: '429' })
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
    __setTierProfilesForTests({ live: onDefault([sonnetRoute()]) })
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
    __setTierProfilesForTests({ live: onDefault([sonnetRoute()]) })
    const req = await run({ profileKeyOverride: PASSTHROUGH_PROFILE_KEY })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.route).toBe(PASSTHROUGH_ROUTE)
    // Nothing was counted: the map was never asked.
    expect(req.tokenCount).toBeUndefined()
  })

  test('a passthrough surface skips the map even when it has a route', async () => {
    __setSurfacesForTests({ 'anthropic-messages': 'passthrough' })
    __setTierProfilesForTests({ live: onDefault([sonnetRoute()]) })
    const req = await run({ body: THINKING })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.resolvedFallbacks).toEqual([])
    expect(req.route).toBe(PASSTHROUGH_ROUTE)
    expect(req.tokenCount).toBeUndefined()
  })

  test('a quota-held list is not a 429 on a passthrough surface', async () => {
    __setSurfacesForTests({ 'anthropic-messages': 'passthrough' })
    __setTierProfilesForTests({ live: onDefault([sonnetRoute()], { exhaustedBehavior: '429' }) })
    markModelExhausted('claude-code', 'claude-sonnet-5')
    const req = await run()
    expect(req.quotaExhaustedRetryAfterSec).toBeUndefined()
  })

  test('the subagent tag is still stripped and recorded, in either spelling', async () => {
    // The marker means nothing to an upstream whichever mode the surface
    // is in.
    __setSurfacesForTests({ 'anthropic-messages': 'passthrough' })
    for (const tag of ['RIALTO-SUBAGENT-MODEL', 'CCR-SUBAGENT-MODEL']) {
      const req = await run({ body: { system: subagentSystem(tag) } })
      expect(req.route).toBe(PASSTHROUGH_ROUTE)
      expect(req.isSubagent).toBe(true)
      expect(textOf(req.body.system, 1)).toBe('')
    }
  })
})

describe('the persona rides on every routed /v1/messages exit', () => {
  test('when a route served the request', async () => {
    __setTierProfilesForTests({ live: onDefault([sonnetRoute()]) })
    const req = await run({ ActivePersona: 'p1' })
    expect(req.body.system).toBe('You are terse.')
  })

  test('when the list had no route', async () => {
    const req = await run({ ActivePersona: 'p1' })
    expect(req.body.model).toBe(CALLER_MODEL)
    expect(req.body.system).toBe('You are terse.')
  })

  test('when the request was answered with a 429', async () => {
    __setTierProfilesForTests({ live: onDefault([sonnetRoute()], { exhaustedBehavior: '429' }) })
    markModelExhausted('claude-code', 'claude-sonnet-5')
    const req = await run({ ActivePersona: 'p1' })
    expect(req.quotaExhaustedRetryAfterSec).toBeGreaterThan(0)
    expect(req.body.system).toBe('You are terse.')
  })

  test('when the map failed to load', async () => {
    __setTierProfilesForTests({ live: new Error('database is away') })
    const req = await run({ ActivePersona: 'p1' })
    expect(req.body.system).toBe('You are terse.')
  })

  test('after the subagent tag is gone', async () => {
    __setTierProfilesForTests({ live: mapWith({ default: { subagent: [codexRoute()] } }) })
    const req = await run({ ActivePersona: 'p1', body: { system: subagentSystem() } })
    // The persona lands in the last text block, which is where the tag
    // was; the marker must not come back with it.
    expect(req.body.model).toBe(CODEX)
    expect(textOf(req.body.system, 1)).toEndWith('You are terse.')
    expect(JSON.stringify(req.body.system)).not.toContain('SUBAGENT')
  })

  test('not on a passthrough surface, which gets exactly what it sent', async () => {
    __setSurfacesForTests({ 'anthropic-messages': 'passthrough' })
    const req = await run({ ActivePersona: 'p1' })
    expect(req.body.system).toBeUndefined()
  })
})
