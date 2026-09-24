/**
 * The tier-map and tier-alias endpoints, against the test database.
 *
 * Pinned: a profile reads back with each route resolved through its alias
 * (the model, whether it can take traffic, web search, context window);
 * an unset alias reads as null rather than failing the page; the reserved
 * passthrough key is refused; promoting a model switches it on and puts it
 * in the quota snapshot at once; clearing an alias that is not there is a
 * 404.
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

const map = (routes: Record<string, unknown[]>) => ({
  routes: { fable: [], opus: [], sonnet: [], haiku: [], other: [], ...routes },
  constraints: { exhaustedBehavior: '429', quotaSkipPct: 100, errorRateSkipPct: 0.5, minHealthSamples: 5 }
})

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
          haiku: [{ provider: 'claude-code', targetTier: 'sonnet', enabled: true }],
          opus: [{ provider: 'claude-code', targetTier: 'opus', enabled: true }]
        })
      )
    )
    expect(put.status).toBe(200)
    expect(await put.json()).toMatchObject({ success: true, warnings: [expect.stringContaining('no opus alias')] })

    const got = await routingProfileRoute.fetch(request('GET', '/api/routing/profiles/live'))
    const body = await got.json()
    expect(body.routes.haiku).toEqual([
      {
        provider: 'claude-code',
        targetTier: 'sonnet',
        enabled: true,
        resolved: { model: 'claude-sonnet-5', targetEnabled: true, hostsWebSearch: true, contextWindow: 1_000_000 }
      }
    ])
    expect(body.routes.opus[0].resolved).toBeNull()
  })

  test('the reserved passthrough key is refused', async () => {
    const res = await routingProfileRoute.fetch(request('PUT', '/api/routing/profiles/passthrough', map({})))
    expect(res.status).toBe(400)
  })

  test('a body that is not a tier map is a validation error', async () => {
    const res = await routingProfileRoute.fetch(
      request('PUT', '/api/routing/profiles/live', { routes: { sonnet: [{ provider: 'x', targetTier: 'mega' }] } })
    )
    expect(res.status).toBe(400)
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
})
