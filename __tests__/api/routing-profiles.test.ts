/**
 * The scenario-route and tier-alias endpoints, against the test database.
 *
 * Pinned: a profile reads back by scenario and lane with each route
 * resolved through its alias (the model, whether it can take traffic, web
 * search, context window) and the Long context threshold in effect; an
 * unset alias reads as null rather than failing the page; a save keeps
 * the threshold tuner's state; the reserved passthrough key is refused;
 * promoting a model switches it on and puts it in the quota snapshot at
 * once; clearing an alias that is not there is a 404.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { providerTierAliasRoute } from '../../src/api/providers/[name]/tier-aliases/[tier]/route'
import { routingProfileRoute } from '../../src/api/routing/profiles/[key]/route'
import { routingProfilesRoute } from '../../src/api/routing/profiles/route'
import { tierAliasesRoute } from '../../src/api/tier-aliases/route'
import { getPrismaClient } from '../../src/db/client'
import { getRoutingSnapshot } from '../../src/services/routing-scheduler'
import { __resetSchedulerStateForTest } from '../../src/services/routing-scheduler/state'
import { HAS_DB, resetDbTables, teardownPrisma } from '../db/helpers'

const request = (method: string, path: string, body?: unknown): Request =>
  new Request(`http://local${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  })

// What the Routing screen PUTs: every list, and the constraints it loaded.
const map = (routes: Record<string, Record<string, unknown[]>>, constraints: Record<string, unknown> = {}) => {
  const lanes = (scenario: string) => ({ agent: [], subagent: [], ...routes[scenario] })
  return {
    routes: { default: lanes('default'), think: lanes('think'), longContext: lanes('longContext') },
    constraints: {
      exhaustedBehavior: '429',
      quotaSkipPct: 100,
      errorRateSkipPct: 0.5,
      minHealthSamples: 5,
      longContextThreshold: null,
      previousLongContextThreshold: null,
      longContextTunedAt: null,
      autoTuneLongContext: true,
      ...constraints
    }
  }
}

describe.skipIf(!HAS_DB)('routing profile and tier alias endpoints', () => {
  beforeEach(async () => {
    await resetDbTables()
    __resetSchedulerStateForTest()
    const prisma = getPrismaClient()
    const claude = await prisma.provider.create({
      data: {
        name: 'claude-code',
        apiBaseUrl: 'https://api.anthropic.com/v1/messages',
        authMode: 'subscription',
        apiStyle: 'anthropic'
      }
    })
    await prisma.model.create({
      data: { providerId: claude.id, name: 'claude-sonnet-5', enabled: true, contextWindow: 1_000_000 }
    })
    await prisma.model.create({ data: { providerId: claude.id, name: 'claude-opus-5', enabled: false } })
  })

  afterAll(teardownPrisma)

  test('escalation restrictions round-trip, survive omitted writes, and clear with an empty list', async () => {
    const path = '/api/routing/profiles/live'
    const save = await routingProfileRoute.fetch(
      request('PUT', path, map({}, { blockedEscalationTiers: ['opus', 'fable'] }))
    )
    expect(save.status).toBe(200)
    const read = await routingProfileRoute.fetch(request('GET', path))
    expect((await read.json()).constraints.blockedEscalationTiers).toEqual(['opus', 'fable'])
    const omitted = await routingProfileRoute.fetch(request('PUT', path, { routes: map({}).routes }))
    expect(omitted.status).toBe(200)
    const kept = await routingProfileRoute.fetch(request('GET', path))
    expect((await kept.json()).constraints.blockedEscalationTiers).toEqual(['opus', 'fable'])
    const clear = await routingProfileRoute.fetch(request('PUT', path, map({}, { blockedEscalationTiers: [] })))
    expect(clear.status).toBe(200)
    const cleared = await routingProfileRoute.fetch(request('GET', path))
    expect((await cleared.json()).constraints.blockedEscalationTiers).toEqual([])
  })

  test('a saved map reads back with each route resolved, and an unset alias as null', async () => {
    const alias = await providerTierAliasRoute.fetch(
      request('PUT', '/api/providers/claude-code/tier-aliases/sonnet', { model: 'claude-sonnet-5' })
    )
    expect(alias.status).toBe(200)

    const put = await routingProfileRoute.fetch(
      request(
        'PUT',
        '/api/routing/profiles/live',
        map({
          default: { agent: [{ provider: 'claude-code', targetTier: 'sonnet', enabled: true }] },
          think: { subagent: [{ provider: 'claude-code', targetTier: 'opus', enabled: true }] }
        })
      )
    )
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({
      success: true,
      warnings: ['think/subagent: claude-code has no opus alias yet; the route is skipped until one is set']
    })

    const got = await routingProfileRoute.fetch(request('GET', '/api/routing/profiles/live'))
    const body = await got.json()
    expect(body.routes.default.agent).toEqual([
      {
        provider: 'claude-code',
        targetTier: 'sonnet',
        enabled: true,
        resolved: { model: 'claude-sonnet-5', targetEnabled: true, hostsWebSearch: true, contextWindow: 1_000_000 }
      }
    ])
    expect(body.routes.default.subagent).toEqual([])
    expect(body.routes.think.subagent[0].resolved).toBeNull()
    expect(body.routes.longContext).toEqual({ agent: [], subagent: [] })
    // 70% of the Default · agent model's million-token window.
    expect(body.longContextThreshold).toBe(700_000)
  })

  test('a profile never saved reads as empty lists with the 128k threshold', async () => {
    const got = await routingProfileRoute.fetch(request('GET', '/api/routing/profiles/never-saved'))
    expect(got.status).toBe(200)
    const body = await got.json()
    expect(body.routes.default).toEqual({ agent: [], subagent: [] })
    expect(body.longContextThreshold).toBe(128_000)
    expect(body.constraints.autoTuneLongContext).toBe(true)
  })

  test('a save keeps the tuner’s threshold, and the view serves it as the one in effect', async () => {
    await providerTierAliasRoute.fetch(
      request('PUT', '/api/providers/claude-code/tier-aliases/sonnet', { model: 'claude-sonnet-5' })
    )
    await getPrismaClient().routerPreferenceProfile.create({
      data: {
        key: 'live',
        constraints: {
          longContextThreshold: 400_000,
          previousLongContextThreshold: 500_000,
          longContextTunedAt: '2026-09-24T03:00:00.000Z'
        }
      }
    })
    // The editor sends back what it loaded before the tune.
    const put = await routingProfileRoute.fetch(
      request(
        'PUT',
        '/api/routing/profiles/live',
        map(
          { default: { agent: [{ provider: 'claude-code', targetTier: 'sonnet', enabled: true }] } },
          { longContextThreshold: null, quotaSkipPct: 90 }
        )
      )
    )
    expect(put.status).toBe(200)
    const body = await (await routingProfileRoute.fetch(request('GET', '/api/routing/profiles/live'))).json()
    expect(body.constraints).toMatchObject({
      quotaSkipPct: 90,
      longContextThreshold: 400_000,
      previousLongContextThreshold: 500_000,
      longContextTunedAt: '2026-09-24T03:00:00.000Z'
    })
    expect(body.longContextThreshold).toBe(400_000)
  })

  test('a knob the body leaves out keeps its stored value: an API save cannot switch the tuner back on', async () => {
    await getPrismaClient().routerPreferenceProfile.create({
      data: { key: 'live', constraints: { autoTuneLongContext: false, quotaSkipPct: 90 } }
    })
    const put = await routingProfileRoute.fetch(
      request('PUT', '/api/routing/profiles/live', {
        routes: { default: { agent: [{ provider: 'claude-code', targetTier: 'sonnet', enabled: true }] } },
        constraints: { exhaustedBehavior: 'passthrough' }
      })
    )
    expect(put.status).toBe(200)
    const body = await (await routingProfileRoute.fetch(request('GET', '/api/routing/profiles/live'))).json()
    expect(body.constraints).toMatchObject({
      exhaustedBehavior: 'passthrough',
      quotaSkipPct: 90,
      autoTuneLongContext: false
    })
  })

  test('the reserved passthrough key is refused', async () => {
    const res = await routingProfileRoute.fetch(request('PUT', '/api/routing/profiles/passthrough', map({})))
    expect(res.status).toBe(400)
  })

  test('a body that is not a scenario map is a validation error', async () => {
    const badTier = await routingProfileRoute.fetch(
      request('PUT', '/api/routing/profiles/live', {
        routes: { default: { agent: [{ provider: 'x', targetTier: 'mega' }] } },
        constraints: {}
      })
    )
    expect(badTier.status).toBe(400)
    // The shape the tier map used: a list per requested tier, not per lane.
    const byTier = await routingProfileRoute.fetch(
      request('PUT', '/api/routing/profiles/live', {
        routes: { default: [{ provider: 'x', targetTier: 'sonnet' }] },
        constraints: {}
      })
    )
    expect(byTier.status).toBe(400)
  })

  test('the lists a body leaves out are saved empty', async () => {
    const res = await routingProfileRoute.fetch(
      request('PUT', '/api/routing/profiles/live', { routes: { think: { agent: [] } }, constraints: {} })
    )
    expect(res.status).toBe(200)
    const body = await (await routingProfileRoute.fetch(request('GET', '/api/routing/profiles/live'))).json()
    expect(body.routes.default).toEqual({ agent: [], subagent: [] })
  })

  test('promoting a model that is off switches it on; the alias list shows it', async () => {
    const res = await providerTierAliasRoute.fetch(
      request('PUT', '/api/providers/claude-code/tier-aliases/opus', { model: 'claude-opus-5' })
    )
    expect(await res.json()).toEqual({ enabledModel: true })
    const model = await getPrismaClient().model.findFirst({ where: { name: 'claude-opus-5' } })
    expect(model?.enabled).toBe(true)
    const list = await (await tierAliasesRoute.fetch(request('GET', '/api/tier-aliases'))).json()
    expect(list.find((a: { tier: string }) => a.tier === 'opus')).toMatchObject({ model: 'claude-opus-5' })
    // The promoted model is a new quota target; the snapshot is republished
    // rather than left for the next tick.
    const snapshot = getRoutingSnapshot()
    expect(snapshot === null ? [] : [...snapshot.targets.keys()]).toContain('claude-code,claude-opus-5')
  })

  test('an unknown provider or model is a 404, and so is clearing an alias that is not set', async () => {
    const provider = await providerTierAliasRoute.fetch(
      request('PUT', '/api/providers/ghost/tier-aliases/opus', { model: 'claude-opus-5' })
    )
    expect(provider.status).toBe(404)
    const model = await providerTierAliasRoute.fetch(
      request('PUT', '/api/providers/claude-code/tier-aliases/opus', { model: 'claude-opus-9' })
    )
    expect(model.status).toBe(404)
    const cleared = await providerTierAliasRoute.fetch(
      request('DELETE', '/api/providers/claude-code/tier-aliases/haiku')
    )
    expect(cleared.status).toBe(404)
  })

  test('profiles are listed with the default first', async () => {
    const list = await (await routingProfilesRoute.fetch(request('GET', '/api/routing/profiles'))).json()
    expect(list.map((p: { key: string }) => p.key)).toEqual(['live', 'passthrough'])
  })

  test('the default stays first once it has a row, ahead of keys that sort before it', async () => {
    await routingProfileRoute.fetch(request('PUT', '/api/routing/profiles/live', map({})))
    await routingProfileRoute.fetch(request('PUT', '/api/routing/profiles/cost-first', map({})))
    const list = await (await routingProfilesRoute.fetch(request('GET', '/api/routing/profiles'))).json()
    expect(list.map((p: { key: string }) => p.key)).toEqual(['live', 'cost-first', 'passthrough'])
  })
})
