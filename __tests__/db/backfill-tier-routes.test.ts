/**
 * The seed-time conversion of each profile's old chain into scenario
 * routes.
 *
 * Pinned against the database: it converts every default / think /
 * longContext list in both lanes, counts the web search and image lists
 * instead, converts once and only once (the mark), leaves a profile an
 * operator already routed alone, converts the default profile first so
 * its aliases are the ones others resolve through, and writes what the
 * planner decided.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import { backfillTierRoutes } from '../../src/services/routing-migration/backfill-tier-routes'
import { resolveTierAliases } from '../../src/services/tier-alias-service'
import { loadTierProfile } from '../../src/services/tier-route-service'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

// "provider·tier[:off]" per route, in order.
const labels = (routes: { provider: string; targetTier: string; enabled: boolean }[]): string[] =>
  routes.map((r) => `${r.provider}·${r.targetTier}${r.enabled ? '' : ':off'}`)

describe.skipIf(!HAS_DB)('backfillTierRoutes', () => {
  beforeEach(async () => {
    await resetDbTables()
  })

  afterAll(teardownPrisma)

  const seedModels = async () => {
    const prisma = getPrismaClient()
    const claude = await prisma.provider.create({
      data: { name: 'claude-code', apiBaseUrl: 'https://api.anthropic.com/v1/messages', authMode: 'subscription' }
    })
    const codex = await prisma.provider.create({
      data: { name: 'codex', apiBaseUrl: 'https://chatgpt.com/backend-api/codex', authMode: 'subscription' }
    })
    const model = (providerId: string, name: string) =>
      prisma.model.create({ data: { providerId, name, enabled: true } })
    return {
      prisma,
      claude,
      codex,
      sonnet: await model(claude.id, 'claude-sonnet-5'),
      opus: await model(claude.id, 'claude-opus-4-8'),
      haiku: await model(claude.id, 'claude-haiku-4-5'),
      gpt: await model(codex.id, 'gpt-5.5')
    }
  }

  // An old chain with something in every list the conversion reads.
  const seedChain = async () => {
    const seeded = await seedModels()
    const { prisma, sonnet, opus, haiku, gpt } = seeded
    const live = await prisma.routerPreferenceProfile.create({
      data: { key: 'live', constraints: { allowEscalation: false } }
    })
    await prisma.routerPreferenceEntry.createMany({
      data: [
        { profileId: live.id, scenario: 'default', kind: 'agent', priority: 1, modelId: sonnet.id },
        { profileId: live.id, scenario: 'default', kind: 'agent', priority: 2, modelId: gpt.id },
        { profileId: live.id, scenario: 'default', kind: 'subagent', priority: 1, modelId: haiku.id },
        { profileId: live.id, scenario: 'think', kind: 'agent', priority: 1, modelId: opus.id },
        { profileId: live.id, scenario: 'think', kind: 'agent', priority: 2, modelId: sonnet.id, enabled: false },
        { profileId: live.id, scenario: 'think', kind: 'subagent', priority: 1, modelId: sonnet.id },
        { profileId: live.id, scenario: 'longContext', kind: 'agent', priority: 1, modelId: sonnet.id },
        { profileId: live.id, scenario: 'longContext', kind: 'subagent', priority: 1, modelId: gpt.id }
      ]
    })
    return { ...seeded, live }
  }

  test('converts every list in both lanes, marks the profile, and does nothing on a second run', async () => {
    const { prisma, live } = await seedChain()
    const [report] = await backfillTierRoutes()
    expect(report).toMatchObject({ profile: 'live', outcome: 'converted', aliases: 4, routes: 8, notes: [] })

    const map = await loadTierProfile('live')
    expect(labels(map.routes.default.agent)).toEqual(['claude-code·sonnet', 'codex·sonnet'])
    expect(labels(map.routes.default.subagent)).toEqual(['claude-code·haiku'])
    expect(labels(map.routes.think.agent)).toEqual(['claude-code·opus', 'claude-code·sonnet:off'])
    expect(labels(map.routes.think.subagent)).toEqual(['claude-code·sonnet'])
    expect(labels(map.routes.longContext.agent)).toEqual(['claude-code·sonnet'])
    expect(labels(map.routes.longContext.subagent)).toEqual(['codex·sonnet'])

    const aliases = await resolveTierAliases()
    expect(aliases.get('claude-code|sonnet')?.model).toBe('claude-sonnet-5')
    expect(aliases.get('claude-code|opus')?.model).toBe('claude-opus-4-8')
    expect(aliases.get('claude-code|haiku')?.model).toBe('claude-haiku-4-5')
    // A model whose name says no tier took its provider's free sonnet slot.
    expect(aliases.get('codex|sonnet')?.model).toBe('gpt-5.5')

    const marked = await prisma.routerPreferenceProfile.findUnique({ where: { id: live.id } })
    expect(marked?.chainBackfilledAt).not.toBeNull()
    const routes = await prisma.tierRoute.count()
    expect(await backfillTierRoutes()).toEqual([])
    expect(await prisma.tierRoute.count()).toBe(routes)
  })

  test('web search and image lists are counted in the notes, not converted', async () => {
    const { prisma, sonnet, opus, gpt } = await seedModels()
    const live = await prisma.routerPreferenceProfile.create({ data: { key: 'live' } })
    await prisma.routerPreferenceEntry.createMany({
      data: [
        { profileId: live.id, scenario: 'default', kind: 'agent', priority: 1, modelId: sonnet.id },
        { profileId: live.id, scenario: 'webSearch', kind: 'agent', priority: 1, modelId: gpt.id },
        { profileId: live.id, scenario: 'webSearch', kind: 'agent', priority: 2, modelId: opus.id },
        { profileId: live.id, scenario: 'image', kind: 'subagent', priority: 1, modelId: opus.id }
      ]
    })
    const [report] = await backfillTierRoutes()
    expect(report.routes).toBe(1)
    // Sorted: entries are read by priority, so lists that tie on it come
    // back in whatever order Postgres returns them.
    expect([...report.notes].sort()).toEqual([
      'image/subagent: 1 entry not converted (web search and image are no longer scenarios)',
      'webSearch/agent: 2 entries not converted (web search and image are no longer scenarios)'
    ])
    // A model only those lists named claims no alias.
    expect((await resolveTierAliases()).has('claude-code|opus')).toBe(false)
    expect((await resolveTierAliases()).has('codex|sonnet')).toBe(false)
  })

  test('a profile that already has routes is only marked', async () => {
    const { prisma, claude, live } = await seedChain()
    await prisma.tierRoute.create({
      data: {
        profileId: live.id,
        scenario: 'think',
        lane: 'agent',
        priority: 1,
        providerId: claude.id,
        targetTier: 'opus'
      }
    })
    const [report] = await backfillTierRoutes()
    expect(report.outcome).toBe('already-routed')
    expect(await prisma.tierRoute.count()).toBe(1)
    expect((await prisma.routerPreferenceProfile.findUnique({ where: { id: live.id } }))?.chainBackfilledAt).not.toBe(
      null
    )
  })

  test('the default profile converts first and claims the aliases; another resolves through them and says so', async () => {
    const { prisma, claude, opus } = await seedChain()
    const sonnet46 = await prisma.model.create({
      data: { providerId: claude.id, name: 'claude-sonnet-4-6', enabled: true }
    })
    // Sorts before `live`, so only the default-first rule puts it second.
    const ci = await prisma.routerPreferenceProfile.create({ data: { key: 'ci' } })
    await prisma.routerPreferenceEntry.createMany({
      data: [
        { profileId: ci.id, scenario: 'default', kind: 'agent', priority: 1, modelId: sonnet46.id },
        { profileId: ci.id, scenario: 'think', kind: 'subagent', priority: 1, modelId: opus.id }
      ]
    })
    const reports = await backfillTierRoutes()
    expect(reports.map((r) => r.profile)).toEqual(['live', 'ci'])
    expect((await resolveTierAliases()).get('claude-code|sonnet')?.model).toBe('claude-sonnet-5')
    const ciReport = reports[1]
    expect(ciReport.aliases).toBe(0)
    expect(ciReport.notes).toEqual([
      "default/agent: claude-code,claude-sonnet-4-6 is reached through claude-code's sonnet alias, which is claude-sonnet-5"
    ])
    const ciMap = await loadTierProfile('ci')
    expect(labels(ciMap.routes.default.agent)).toEqual(['claude-code·sonnet'])
    expect(labels(ciMap.routes.think.subagent)).toEqual(['claude-code·opus'])
  })

  test('a profile with no chain is marked with no routes: it passes through, as an empty lane did', async () => {
    const prisma = getPrismaClient()
    await prisma.routerPreferenceProfile.create({ data: { key: 'live' } })
    const [report] = await backfillTierRoutes()
    expect(report).toMatchObject({ outcome: 'converted', routes: 0 })
  })
})
