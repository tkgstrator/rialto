/**
 * The stored tier map.
 *
 * Pinned: a save replaces the whole profile and reads back in order; a
 * route to a provider that does not exist, or a duplicate, is dropped with
 * a warning, while one whose alias is unset is kept and warned about; the
 * reserved passthrough key cannot hold routes; and the constraints merge
 * into the blob the old chain still reads rather than replacing it.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import type { TierProfile } from '../../src/schemas/domain/tier-route'
import { setTierAlias } from '../../src/services/tier-alias-service'
import { listTierProfiles, loadTierProfile, saveTierProfile } from '../../src/services/tier-route-service'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

const constraints = { exhaustedBehavior: '429' as const, quotaSkipPct: 100, errorRateSkipPct: 0.5, minHealthSamples: 5 }

const profile = (
  routes: Partial<TierProfile['routes']>,
  over: Partial<TierProfile['constraints']> = {}
): TierProfile => ({
  routes: { fable: [], opus: [], sonnet: [], haiku: [], other: [], ...routes },
  constraints: { ...constraints, ...over }
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
    await prisma.model.create({ data: { providerId: claude.id, name: 'claude-sonnet-5', enabled: true } })
    await setTierAlias('claude-code', 'sonnet', 'claude-sonnet-5')
  })

  afterAll(teardownPrisma)

  test('a saved map reads back in order, every tier present', async () => {
    const outcome = await saveTierProfile(
      'live',
      profile({
        sonnet: [
          { provider: 'claude-code', targetTier: 'sonnet', enabled: true },
          { provider: 'codex', targetTier: 'sonnet', enabled: false }
        ],
        haiku: [{ provider: 'claude-code', targetTier: 'sonnet', enabled: true }]
      })
    )
    expect(outcome.success).toBe(true)
    const loaded = await loadTierProfile('live')
    expect(loaded.routes.sonnet).toEqual([
      { provider: 'claude-code', targetTier: 'sonnet', enabled: true },
      { provider: 'codex', targetTier: 'sonnet', enabled: false }
    ])
    expect(loaded.routes.haiku).toEqual([{ provider: 'claude-code', targetTier: 'sonnet', enabled: true }])
    expect(loaded.routes.other).toEqual([])
  })

  test('an unknown provider and a duplicate are dropped; an unset alias is kept, all with warnings', async () => {
    const outcome = await saveTierProfile(
      'live',
      profile({
        sonnet: [
          { provider: 'claude-code', targetTier: 'sonnet', enabled: true },
          { provider: 'claude-code', targetTier: 'sonnet', enabled: true },
          { provider: 'ghost', targetTier: 'sonnet', enabled: true },
          { provider: 'codex', targetTier: 'opus', enabled: true }
        ]
      })
    )
    expect(outcome.warnings).toHaveLength(3)
    expect(outcome.warnings.join('\n')).toContain('"ghost" does not exist')
    expect(outcome.warnings.join('\n')).toContain('listed twice')
    expect(outcome.warnings.join('\n')).toContain('codex has no opus alias')
    expect((await loadTierProfile('live')).routes.sonnet.map((r) => `${r.provider}·${r.targetTier}`)).toEqual([
      'claude-code·sonnet',
      'codex·opus'
    ])
  })

  test('a second save replaces the first', async () => {
    await saveTierProfile(
      'live',
      profile({ sonnet: [{ provider: 'claude-code', targetTier: 'sonnet', enabled: true }] })
    )
    await saveTierProfile('live', profile({ opus: [{ provider: 'codex', targetTier: 'opus', enabled: true }] }))
    const loaded = await loadTierProfile('live')
    expect(loaded.routes.sonnet).toEqual([])
    expect(loaded.routes.opus).toHaveLength(1)
  })

  test('the reserved passthrough key cannot hold routes', async () => {
    const outcome = await saveTierProfile('passthrough', profile({}))
    expect(outcome.success).toBe(false)
  })

  test('constraints merge into the blob the old chain still reads', async () => {
    const prisma = getPrismaClient()
    await prisma.routerPreferenceProfile.create({
      data: { key: 'live', constraints: { allowEscalation: false, exhaustedBehavior: 'passthrough' } }
    })
    await saveTierProfile('live', profile({}, { exhaustedBehavior: '429', quotaSkipPct: 90 }))
    const row = await prisma.routerPreferenceProfile.findUnique({ where: { key: 'live' } })
    expect(row?.constraints).toMatchObject({ allowEscalation: false, exhaustedBehavior: '429', quotaSkipPct: 90 })
    expect((await loadTierProfile('live')).constraints).toEqual({ ...constraints, quotaSkipPct: 90 })
  })

  test('profiles are listed with the default first and the reserved key last', async () => {
    await saveTierProfile('ci', profile({ other: [{ provider: 'codex', targetTier: 'sonnet', enabled: true }] }))
    const listed = await listTierProfiles()
    expect(listed.map((p) => `${p.key}:${p.kind}:${p.routeCount}`)).toEqual([
      'live:map:0',
      'ci:map:1',
      'passthrough:passthrough:0'
    ])
  })
})
