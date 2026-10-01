import { beforeEach, describe, expect, test } from 'bun:test'
import dayjs from '../../src/lib/dayjs'
import { __setTierProfilesForTests } from '../../src/llms/tier-router/runtime'
import { markModelExhausted, markProviderExhausted } from '../../src/services/failover-state'
import { recordModelFailure } from '../../src/services/routing-scheduler/model-health'
import { createRouteRequestFixture } from './route-request-fixture'
import { mapWith } from './tier-fixture'

describe('routeRequest: pace and gates', () => {
  const {
    logged,
    SONNET,
    CODEX,
    OPUS,
    sonnetRoute,
    codexRoute,
    opusRoute,
    onDefault,
    run,
    THINKING,
    publishQuota,
    failRepeatedly
  } = createRouteRequestFixture()

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

    test('every route over pace still serves, least over first: a projection alone never refuses a request', async () => {
      publishQuota({
        [SONNET]: { projectedPct: 150 },
        [CODEX]: { projectedPct: 140 },
        [OPUS]: { projectedPct: 101 }
      })
      const req = await run()
      expect(req.body.model).toBe(OPUS)
      expect(req.resolvedFallbacks).toEqual([CODEX, SONNET])
      expect(req.quotaExhaustedRetryAfterSec).toBeUndefined()
      expect(paceLines()).toHaveLength(1)
    })

    // Opus and Sonnet on one subscription share its 5h and weekly windows, so
    // the snapshot gives them the same pace. Over it, Opus must still step
    // down: Sonnet spends the shared budget more slowly.
    test('over pace on one subscription, the lower tier takes the traffic', async () => {
      __setTierProfilesForTests({ live: onDefault([opusRoute(), sonnetRoute()]) })
      publishQuota({ [OPUS]: { projectedPct: 200 }, [SONNET]: { projectedPct: 200 } })
      const req = await run()
      expect(req.body.model).toBe(SONNET)
      expect(req.resolvedFallbacks).toEqual([OPUS])
      expect(paceLines()).toHaveLength(1)
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

    test('spent account-wide weekly holds every provider route before pace, even one absent from targets', async () => {
      __setTierProfilesForTests({ live: onDefault([sonnetRoute(), opusRoute(), codexRoute()]) })
      const resetAt = dayjs().add(2, 'hour').valueOf()
      publishQuota({ [SONNET]: { projectedPct: 10, remainingBudgetPct: 90 } }, [
        {
          subAccountId: 'a',
          providerName: 'claude-code',
          kind: 'claude',
          fiveHour: { used: 0, limit: 100, resetAt: null, windowLengthMs: null },
          weekly: { used: 100, limit: 100, resetAt, windowLengthMs: 7 * 24 * 3_600_000 },
          refreshedAt: dayjs().valueOf(),
          stale: false
        }
      ])
      const req = await run()
      expect(req.body.model).toBe(CODEX)
      expect(req.resolvedFallbacks).toEqual([])
    })

    test('provider-wide snapshot exhaustion gives a missing target its account reset for Retry-After', async () => {
      __setTierProfilesForTests({ live: onDefault([opusRoute()], { exhaustedBehavior: '429' }) })
      const resetAt = dayjs().add(2, 'hour').valueOf()
      publishQuota({}, [
        {
          subAccountId: 'a',
          providerName: 'claude-code',
          kind: 'claude',
          fiveHour: { used: 100, limit: 100, resetAt, windowLengthMs: 5 * 3_600_000 },
          weekly: null,
          refreshedAt: dayjs().valueOf(),
          stale: false
        }
      ])
      const req = await run()
      expect(req.quotaExhaustedRetryAfterSec).toBeGreaterThanOrEqual(7199)
      expect(req.quotaExhaustedRetryAfterSec).toBeLessThanOrEqual(7200)
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
      const req = await run({
        body: { messages: [{ role: 'user', content: 'lorem ipsum dolor sit amet '.repeat(50) }] }
      })
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
})
