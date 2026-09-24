/**
 * The reserved `passthrough` profile.
 *
 * Routing mode is otherwise a property of the inbound surface, which
 * makes it all-or-nothing: every client on an endpoint is routed, or
 * none is. Pointing a token or a surface at this key opts that traffic
 * out on its own, so what has to hold is that it never behaves like a
 * tier map — it cannot be written to, it does not appear as one in the
 * picker, and a surface carrying it is passthrough whatever its mode
 * column says.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import { invalidateSurfaceCache, isRoutedPath, updateSurface } from '../../src/services/inbound-surface-service'
import {
  DEFAULT_PROFILE_KEY,
  listTierProfiles,
  PASSTHROUGH_PROFILE_KEY,
  saveTierProfile
} from '../../src/services/tier-route-service'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

const emptyMap = () => ({
  routes: { fable: [], opus: [], sonnet: [], haiku: [], other: [] },
  constraints: { exhaustedBehavior: '429' as const, quotaSkipPct: 100, errorRateSkipPct: 0.5, minHealthSamples: 5 }
})

describe.skipIf(!HAS_DB)('passthrough profile', () => {
  beforeEach(async () => {
    await resetDbTables()
    invalidateSurfaceCache()
  })

  afterAll(teardownPrisma)

  test('is offered by the picker alongside the real maps', async () => {
    const profiles = await listTierProfiles()
    const reserved = profiles.find((p) => p.key === PASSTHROUGH_PROFILE_KEY)
    expect(reserved?.kind).toBe('passthrough')
    expect(reserved?.routeCount).toBe(0)
    expect(profiles.find((p) => p.key === DEFAULT_PROFILE_KEY)?.kind).toBe('map')
  })

  test('refuses to store a map, rather than storing one that never runs', async () => {
    const outcome = await saveTierProfile(PASSTHROUGH_PROFILE_KEY, emptyMap())
    expect(outcome.success).toBe(false)
    expect(outcome.warnings.join(' ')).toContain('reserved')
    expect(await getPrismaClient().routerPreferenceProfile.count()).toBe(0)
  })

  test('a surface pointed at it is passthrough even with routingMode routed', async () => {
    // The reserved key has to mean the same thing wherever it appears,
    // or the two fields can disagree about the same request.
    await updateSurface({ surface: 'anthropic-messages', routingMode: 'routed', profileKey: PASSTHROUGH_PROFILE_KEY })
    expect(await isRoutedPath('/v1/messages')).toBe(false)
  })

  test('pointing a surface back at a real profile restores routing', async () => {
    await updateSurface({ surface: 'anthropic-messages', routingMode: 'routed', profileKey: PASSTHROUGH_PROFILE_KEY })
    await updateSurface({ surface: 'anthropic-messages', routingMode: 'routed', profileKey: DEFAULT_PROFILE_KEY })
    expect(await isRoutedPath('/v1/messages')).toBe(true)
  })

  test('a stored row using the reserved key never shadows the real behaviour', async () => {
    // The write path refuses it, but a row predating that guard must not
    // make the picker offer it as an editable map.
    await getPrismaClient().routerPreferenceProfile.create({ data: { key: PASSTHROUGH_PROFILE_KEY } })
    const profiles = await listTierProfiles()
    expect(profiles.filter((p) => p.key === PASSTHROUGH_PROFILE_KEY)).toHaveLength(1)
    expect(profiles.find((p) => p.key === PASSTHROUGH_PROFILE_KEY)?.kind).toBe('passthrough')
  })
})
