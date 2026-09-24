/**
 * The stored scenario routes.
 *
 * Pinned: a save replaces the whole profile and reads back in order, every
 * scenario and lane present; a route to a provider that does not exist, or
 * a duplicate within a list, is dropped with a warning naming the list,
 * while one whose alias is unset is kept and warned about; the reserved
 * passthrough key cannot hold routes; the constraints merge into the blob
 * the old chain still reads rather than replacing it, and a save keeps the
 * Long context tuner's state from the database; and the view resolves
 * each route and serves the threshold in effect.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import type { ModelTier } from '../../src/schemas/domain/tier-route'
import { setTierAlias } from '../../src/services/tier-alias-service'
import {
  listTierProfiles,
  loadTierProfile,
  loadTierProfileView,
  saveTierProfile
} from '../../src/services/tier-route-service'
import { DEFAULT_CONSTRAINTS, profileWith } from '../llms/tier-fixture'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

// A route switched on.
const on = (provider: string, targetTier: ModelTier) => ({
  provider,
  targetTier,
  enabled: true
})

describe.skipIf(!HAS_DB)('tier-route-service', () => {
  beforeEach(async () => {
    await resetDbTables()
    const prisma = getPrismaClient()
    const claude = await prisma.provider.create({
      data: { name: 'claude-code', apiBaseUrl: 'https://api.anthropic.com/v1/messages', authMode: 'subscription' }
    })
    await prisma.provider.create({
      data: { name: 'codex', apiBaseUrl: 'https://chatgpt.com/backend-api/codex', authMode: 'subscription' }
    })
    await prisma.model.create({
      data: { providerId: claude.id, name: 'claude-sonnet-5', enabled: true, contextWindow: 1_000_000 }
    })
    await setTierAlias('claude-code', 'sonnet', 'claude-sonnet-5')
  })

  afterAll(teardownPrisma)

  test('a saved map reads back in order, every scenario and lane present', async () => {
    const outcome = await saveTierProfile(
      'live',
      profileWith({
        default: {
          agent: [on('claude-code', 'sonnet'), { provider: 'codex', targetTier: 'sonnet', enabled: false }],
          subagent: [on('codex', 'haiku')]
        },
        think: { subagent: [on('claude-code', 'sonnet')] },
        longContext: { agent: [on('claude-code', 'sonnet')] }
      })
    )
    expect(outcome.success).toBe(true)
    const loaded = await loadTierProfile('live')
    expect(loaded.routes).toEqual({
      default: {
        agent: [on('claude-code', 'sonnet'), { provider: 'codex', targetTier: 'sonnet', enabled: false }],
        subagent: [on('codex', 'haiku')]
      },
      think: { agent: [], subagent: [on('claude-code', 'sonnet')] },
      longContext: { agent: [on('claude-code', 'sonnet')], subagent: [] }
    })
  })

  test('an unknown provider and a duplicate are dropped; an unset alias is kept; the warnings name the list', async () => {
    const outcome = await saveTierProfile(
      'live',
      profileWith({
        think: {
          agent: [on('claude-code', 'sonnet'), on('claude-code', 'sonnet'), on('ghost', 'sonnet'), on('codex', 'opus')]
        }
      })
    )
    expect(outcome.warnings).toEqual([
      'think/agent: claude-code · sonnet is listed twice; kept the first',
      'think/agent: provider "ghost" does not exist; route dropped',
      'think/agent: codex has no opus alias yet; the route is skipped until one is set'
    ])
    expect((await loadTierProfile('live')).routes.think.agent.map((r) => `${r.provider}·${r.targetTier}`)).toEqual([
      'claude-code·sonnet',
      'codex·opus'
    ])
  })

  test('a provider tier appears once per list, and in as many lists as it likes', async () => {
    const outcome = await saveTierProfile(
      'live',
      profileWith({
        default: { agent: [on('claude-code', 'sonnet')], subagent: [on('claude-code', 'sonnet')] },
        think: { agent: [on('claude-code', 'sonnet')] }
      })
    )
    expect(outcome.warnings).toEqual([])
    expect(await getPrismaClient().tierRoute.count()).toBe(3)
  })

  test('a second save replaces the first', async () => {
    await saveTierProfile('live', profileWith({ default: { agent: [on('claude-code', 'sonnet')] } }))
    await saveTierProfile('live', profileWith({ longContext: { subagent: [on('codex', 'opus')] } }))
    const loaded = await loadTierProfile('live')
    expect(loaded.routes.default.agent).toEqual([])
    expect(loaded.routes.longContext.subagent).toHaveLength(1)
  })

  test('the reserved passthrough key cannot hold routes', async () => {
    const outcome = await saveTierProfile('passthrough', profileWith({}))
    expect(outcome.success).toBe(false)
  })

  test('a profile with no row reads as empty, with every knob at its default', async () => {
    expect(await loadTierProfile('never-saved')).toEqual(profileWith({}))
  })

  test('constraints merge into the blob the old chain still reads', async () => {
    const prisma = getPrismaClient()
    await prisma.routerPreferenceProfile.create({
      data: { key: 'live', constraints: { allowEscalation: false, exhaustedBehavior: 'passthrough' } }
    })
    await saveTierProfile('live', profileWith({}, { exhaustedBehavior: '429', quotaSkipPct: 90 }))
    const row = await prisma.routerPreferenceProfile.findUnique({ where: { key: 'live' } })
    expect(row?.constraints).toMatchObject({ allowEscalation: false, exhaustedBehavior: '429', quotaSkipPct: 90 })
    expect((await loadTierProfile('live')).constraints).toEqual({ ...DEFAULT_CONSTRAINTS, quotaSkipPct: 90 })
  })

  test("a save keeps the tuner's state from the database, not what the editor loaded before it", async () => {
    // The tuner can move the threshold between an editor's load and its
    // save; writing back what the editor saw would undo that tune.
    const prisma = getPrismaClient()
    const tuned = {
      longContextThreshold: 80_000,
      previousLongContextThreshold: 100_000,
      longContextTunedAt: '2026-09-24T03:00:00.000Z'
    }
    await prisma.routerPreferenceProfile.create({ data: { key: 'live', constraints: tuned } })
    await saveTierProfile(
      'live',
      profileWith(
        {},
        {
          quotaSkipPct: 90,
          longContextThreshold: 100_000,
          previousLongContextThreshold: null,
          longContextTunedAt: '2026-09-23T03:00:00.000Z',
          autoTuneLongContext: false
        }
      )
    )
    // The operator's knobs are the editor's to set, the kill switch included.
    expect((await loadTierProfile('live')).constraints).toEqual({
      ...DEFAULT_CONSTRAINTS,
      ...tuned,
      quotaSkipPct: 90,
      autoTuneLongContext: false
    })
  })

  test('profiles are listed with the default first and the reserved key last, counting every list', async () => {
    await saveTierProfile(
      'ci',
      profileWith({ default: { agent: [on('codex', 'sonnet')] }, think: { subagent: [on('codex', 'opus')] } })
    )
    const listed = await listTierProfiles()
    expect(listed.map((p) => `${p.key}:${p.kind}:${p.routeCount}`)).toEqual([
      'live:map:0',
      'ci:map:2',
      'passthrough:passthrough:0'
    ])
  })
})

describe.skipIf(!HAS_DB)('loadTierProfileView', () => {
  beforeEach(async () => {
    await resetDbTables()
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
    await prisma.model.create({
      data: { providerId: claude.id, name: 'claude-opus-4-8', enabled: true, contextWindow: 200_000 }
    })
    await setTierAlias('claude-code', 'sonnet', 'claude-sonnet-5')
    await setTierAlias('claude-code', 'opus', 'claude-opus-4-8')
  })

  afterAll(teardownPrisma)

  test('each route is resolved through its alias, in every list', async () => {
    await saveTierProfile(
      'live',
      profileWith({
        default: { agent: [on('claude-code', 'sonnet')] },
        think: { subagent: [on('claude-code', 'opus'), on('claude-code', 'haiku')] }
      })
    )
    const view = await loadTierProfileView('live')
    expect(view.routes.default.agent[0].resolved).toEqual({
      model: 'claude-sonnet-5',
      targetEnabled: true,
      hostsWebSearch: true,
      contextWindow: 1_000_000
    })
    expect(view.routes.think.subagent.map((r) => (r.resolved === null ? null : r.resolved.model))).toEqual([
      'claude-opus-4-8',
      null
    ])
    expect(view.routes.longContext).toEqual({ agent: [], subagent: [] })
  })

  test("the threshold is 70% of the first usable Default · agent route's window", async () => {
    await saveTierProfile(
      'live',
      profileWith({
        default: {
          agent: [{ provider: 'claude-code', targetTier: 'opus', enabled: false }, on('claude-code', 'sonnet')],
          // Another lane's window does not count.
          subagent: [on('claude-code', 'opus')]
        }
      })
    )
    expect((await loadTierProfileView('live')).longContextThreshold).toBe(700_000)
  })

  test('128k when no Default · agent route reaches a model that can take traffic', async () => {
    await saveTierProfile('live', profileWith({ default: { agent: [on('claude-code', 'sonnet')] } }))
    await getPrismaClient().model.updateMany({ where: { name: 'claude-sonnet-5' }, data: { enabled: false } })
    expect((await loadTierProfileView('live')).longContextThreshold).toBe(128_000)
    expect((await loadTierProfileView('never-saved')).longContextThreshold).toBe(128_000)
  })

  test('a tuned threshold is served as the one in effect, kept under the base', async () => {
    await saveTierProfile('live', profileWith({ default: { agent: [on('claude-code', 'opus')] } }))
    const prisma = getPrismaClient()
    const setStored = (longContextThreshold: number) =>
      prisma.routerPreferenceProfile.update({ where: { key: 'live' }, data: { constraints: { longContextThreshold } } })
    await setStored(90_000)
    const view = await loadTierProfileView('live')
    expect(view.longContextThreshold).toBe(90_000)
    expect(view.constraints.longContextThreshold).toBe(90_000)
    // Opus's 200k window makes the base 140k.
    await setStored(500_000)
    expect((await loadTierProfileView('live')).longContextThreshold).toBe(140_000)
  })
})
