import { describe, expect, test } from 'bun:test'
import { PASSTHROUGH_ROUTE } from '../../src/llms/router'
import { __setTierProfilesForTests } from '../../src/llms/tier-router/runtime'
import { markModelExhausted } from '../../src/services/failover-state'
import { __setSurfacesForTests } from '../../src/services/inbound-surface-service'
import { PASSTHROUGH_PROFILE_KEY } from '../../src/services/tier-route-service'
import { createRouteRequestFixture } from './route-request-fixture'
import { mapWith, route } from './tier-fixture'

describe('routeRequest: passthrough and persona', () => {
  const {
    CALLER_MODEL,
    SONNET,
    CODEX,
    sonnetRoute,
    codexRoute,
    opusRoute,
    onDefault,
    run,
    THINKING,
    subagentSystem,
    textOf,
    publishQuota
  } = createRouteRequestFixture()

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

  describe('escalation restrictions reach the request path', () => {
    test.each(['agent', 'subagent'] as const)('restricts primary and fallbacks on the %s lane', async (lane) => {
      const routes = [route('claude-code', 'fable', 'claude-fable-5-1'), opusRoute(), sonnetRoute(), codexRoute()]
      __setTierProfilesForTests({
        live: mapWith({ default: { [lane]: routes } }, { blockedEscalationTiers: ['opus', 'fable'] })
      })
      publishQuota({ 'claude-code,claude-fable-5-1': { projectedPct: 10 } })
      const req = await run({ body: lane === 'subagent' ? { system: subagentSystem() } : {} })
      expect(req.body.model).toBe(SONNET)
      expect(req.resolvedFallbacks).toEqual([CODEX])
      expect(req.routingRefusal).toBeUndefined()
    })

    test('provider-qualified models infer tier from the model, not the provider name', async () => {
      __setTierProfilesForTests({ live: onDefault([opusRoute(), sonnetRoute()], { blockedEscalationTiers: ['opus'] }) })
      expect((await run({ model: 'fable-provider,claude-sonnet-5' })).body.model).toBe(SONNET)
    })
  })
})
