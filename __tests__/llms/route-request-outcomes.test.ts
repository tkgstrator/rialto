import { describe, expect, test } from 'bun:test'
import dayjs from '../../src/lib/dayjs'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { PASSTHROUGH_ROUTE } from '../../src/llms/router'
import { __setTierProfilesForTests } from '../../src/llms/tier-router/runtime'
import { markModelExhausted } from '../../src/services/failover-state'
import { createRouteRequestFixture } from './route-request-fixture'
import { mapWith, route } from './tier-fixture'

describe('routeRequest: exhaustion and refusal', () => {
  const {
    logged,
    CALLER_MODEL,
    SONNET,
    CODEX,
    sonnetRoute,
    codexRoute,
    longRoute,
    onDefault,
    run,
    subagentSystem,
    textOf,
    LONG_BODY,
    tokensOf,
    windowPuttingThresholdBelow,
    publishQuota,
    failRepeatedly
  } = createRouteRequestFixture()

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
      const req = await run({
        body: { messages: [{ role: 'user', content: 'lorem ipsum dolor sit amet '.repeat(50) }] }
      })
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
})
