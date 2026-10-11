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

import { describe, expect, test } from 'bun:test'
import dayjs from '../../src/lib/dayjs'
import { PASSTHROUGH_ROUTE } from '../../src/llms/router'
import { __setTierProfilesForTests } from '../../src/llms/tier-router/runtime'
import { markModelExhausted } from '../../src/services/failover-state'
import { createRouteRequestFixture } from './route-request-fixture'
import { mapWith, route } from './tier-fixture'

describe('routeRequest: classification', () => {
  const {
    logged,
    CALLER_MODEL,
    SONNET,
    CODEX,
    OPUS,
    LONG,
    sonnetRoute,
    codexRoute,
    opusRoute,
    longRoute,
    onDefault,
    everyList,
    run,
    THINKING,
    subagentSystem,
    textOf,
    LONG_BODY,
    tokensOf,
    windowPuttingThresholdBelow,
    windowPuttingThresholdAbove
  } = createRouteRequestFixture()

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

    test('shadow model and effort estimates never replace the routed target or explicit request fields', async () => {
      const previousEnabled = process.env.JEFF_SHADOW_ENABLED
      const previousUrl = process.env.JEFF_URL
      const previousFetch = globalThis.fetch
      const calls: string[] = []
      process.env.JEFF_SHADOW_ENABLED = 'true'
      process.env.JEFF_URL = 'http://127.0.0.1:8000'
      globalThis.fetch = async (_url, options) => {
        calls.push(String(options?.body))
        return Response.json({
          model: 'jeff-latest',
          answers: {
            complexity: {
              type: 'score',
              score: 0.6,
              confidence: 0.7,
              probabilities: { '0': 0.4, '1': 0.6 },
              legend: { '0': 'Simple', '1': 'Complex' }
            },
            modelEffort: {
              type: 'choice',
              choice: '3',
              confidence: 0.8,
              probabilities: { '1': 0.1, '2': 0.1, '3': 0.8 }
            }
          },
          usage: { input_tokens: 25, output_tokens: 0 }
        })
      }
      try {
        __setTierProfilesForTests({
          live: mapWith({ default: { subagent: [sonnetRoute({ efforts: ['low', 'high'] }), codexRoute()] } })
        })
        const messages = [{ role: 'user', content: 'Please review this implementation' }]
        const req = await run({ body: { system: subagentSystem(), messages, output_config: { effort: 'high' } } })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(req.body.model).toBe(SONNET)
        expect(req.resolvedFallbacks).toEqual([CODEX])
        expect(req.body.messages).toEqual(messages)
        expect(req.body.output_config).toEqual({ effort: 'high' })
        expect(calls).toHaveLength(1)
        expect(Object.keys(JSON.parse(calls[0]).questions)).toEqual(['complexity', 'modelEffort'])
        expect(logged.lines.join(' ')).toContain('"estimatedEffort":"vendor_default"')
        expect(logged.lines.join(' ')).not.toContain('Please review this implementation')
      } finally {
        globalThis.fetch = previousFetch
        if (previousEnabled === undefined) delete process.env.JEFF_SHADOW_ENABLED
        else process.env.JEFF_SHADOW_ENABLED = previousEnabled
        if (previousUrl === undefined) delete process.env.JEFF_URL
        else process.env.JEFF_URL = previousUrl
      }
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
        live: mapWith({
          default: { agent: [sonnetRoute()], subagent: [codexRoute()] },
          think: { agent: [opusRoute()] }
        })
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
})
