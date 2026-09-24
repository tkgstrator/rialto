/**
 * The seed-time conversion of each profile's chain into the tier map.
 *
 * Pinned against the database: it converts once and only once (the
 * mark), leaves a profile an operator already routed alone, converts the
 * default profile first so its aliases are the ones others resolve
 * through, and writes what the planner decided.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import { backfillTierRoutes } from '../../src/services/routing-migration/backfill-tier-routes'
import { resolveTierAliases } from '../../src/services/tier-alias-service'
import { loadTierProfile } from '../../src/services/tier-route-service'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

describe.skipIf(!HAS_DB)('backfillTierRoutes', () => {
  beforeEach(async () => {
    await resetDbTables()
  })

  afterAll(teardownPrisma)

  const seedChain = async () => {
    const prisma = getPrismaClient()
    const claude = await prisma.provider.create({
      data: { name: 'claude-code', apiBaseUrl: 'https://api.anthropic.com/v1/messages', authMode: 'subscription' }
    })
    const sonnet = await prisma.model.create({
      data: { providerId: claude.id, name: 'claude-sonnet-5', enabled: true }
    })
    const opus = await prisma.model.create({ data: { providerId: claude.id, name: 'claude-opus-4-8', enabled: true } })
    const live = await prisma.routerPreferenceProfile.create({
      data: { key: 'live', constraints: { allowEscalation: false } }
    })
    await prisma.routerPreferenceEntry.createMany({
      data: [
        { profileId: live.id, scenario: 'default', kind: 'agent', priority: 1, modelId: sonnet.id },
        { profileId: live.id, scenario: 'think', kind: 'agent', priority: 1, modelId: opus.id }
      ]
    })
    return { prisma, claude, sonnet, opus, live }
  }

  test('converts the default/agent chain, marks the profile, and does nothing on a second run', async () => {
    const { prisma, live } = await seedChain()
    const [report] = await backfillTierRoutes()
    expect(report).toMatchObject({ profile: 'live', outcome: 'converted', aliases: 1 })
    expect(report.notes).toContain('think/agent: 1 entry not converted (lanes other than default/agent are gone)')

    const map = await loadTierProfile('live')
    expect(map.routes.sonnet).toEqual([{ provider: 'claude-code', targetTier: 'sonnet', enabled: true }])
    // "down only" plus the nearest-tier fallback: Haiku stays on Sonnet.
    expect(map.routes.haiku).toEqual([{ provider: 'claude-code', targetTier: 'sonnet', enabled: true }])
    expect((await resolveTierAliases()).get('claude-code|sonnet')?.model).toBe('claude-sonnet-5')

    const marked = await prisma.routerPreferenceProfile.findUnique({ where: { id: live.id } })
    expect(marked?.chainBackfilledAt).not.toBeNull()
    const routes = await prisma.tierRoute.count()
    expect(await backfillTierRoutes()).toEqual([])
    expect(await prisma.tierRoute.count()).toBe(routes)
  })

  test('a profile that already has tier routes is only marked', async () => {
    const { prisma, claude, live } = await seedChain()
    await prisma.tierRoute.create({
      data: { profileId: live.id, requestedTier: 'opus', priority: 1, providerId: claude.id, targetTier: 'opus' }
    })
    const [report] = await backfillTierRoutes()
    expect(report.outcome).toBe('already-routed')
    expect(await prisma.tierRoute.count()).toBe(1)
  })

  test('the default profile claims the aliases; another resolves through them and says so', async () => {
    const { prisma, claude, opus } = await seedChain()
    const sonnet46 = await prisma.model.create({
      data: { providerId: claude.id, name: 'claude-sonnet-4-6', enabled: true }
    })
    const ci = await prisma.routerPreferenceProfile.create({ data: { key: 'ci' } })
    await prisma.routerPreferenceEntry.createMany({
      data: [
        { profileId: ci.id, scenario: 'default', kind: 'agent', priority: 1, modelId: sonnet46.id },
        { profileId: ci.id, scenario: 'default', kind: 'agent', priority: 2, modelId: opus.id }
      ]
    })
    const reports = await backfillTierRoutes()
    expect(reports.map((r) => r.profile)).toEqual(['live', 'ci'])
    expect((await resolveTierAliases()).get('claude-code|sonnet')?.model).toBe('claude-sonnet-5')
    const ciReport = reports[1]
    expect(
      ciReport.notes.some((n) => n.includes('claude-sonnet-4-6 is reached through') && n.includes('claude-sonnet-5'))
    ).toBe(true)
  })

  test('a profile with no chain is marked with no routes: it passes through, as an empty lane did', async () => {
    const prisma = getPrismaClient()
    await prisma.routerPreferenceProfile.create({ data: { key: 'live' } })
    const [report] = await backfillTierRoutes()
    expect(report).toMatchObject({ outcome: 'converted', routes: 0 })
  })
})
