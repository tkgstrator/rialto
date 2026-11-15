/**
 * The denied-targets list is the one stored setting that changes which
 * models a surface will dispatch, so these tests pin the things that must
 * not drift: a surface with no row denies nothing, and a write takes effect
 * on the hot path, which reads through a cache.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import {
  invalidateSurfaceCache,
  listSurfaces,
  passthroughDenial,
  resolveSurfaceForPath,
  updateSurface
} from '../../src/services/inbound-surface-service'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

const describeDb = HAS_DB ? describe : describe.skip

describeDb('inbound-surface-service', () => {
  beforeEach(async () => {
    await resetDbTables()
    invalidateSurfaceCache()
  })

  afterAll(teardownPrisma)

  test('a surface with no stored row denies nothing', async () => {
    const surfaces = await listSurfaces()
    expect(surfaces.length).toBeGreaterThan(0)
    expect(surfaces.every((s) => s.deniedTargets.length === 0)).toBe(true)
    expect(await getPrismaClient().inboundSurfaceConfig.count()).toBe(0)
  })

  test('the gemini surface resolves from a model-and-action path', async () => {
    const surface = await resolveSurfaceForPath('/v1beta/models/gemini-3-pro:streamGenerateContent')
    expect(surface?.id).toBe('gemini-generate')
  })

  test('an unknown path resolves to no surface', async () => {
    expect(await resolveSurfaceForPath('/v1/something-new')).toBeUndefined()
    expect(await resolveSurfaceForPath(undefined)).toBeUndefined()
  })

  test('a write takes effect on the hot path, which reads through a cache', async () => {
    await listSurfaces()
    await updateSurface({ surface: 'openai-chat', deniedTargets: ['codex,gpt-5.5'] })

    expect((await resolveSurfaceForPath('/v1/chat/completions'))?.deniedTargets).toEqual(['codex,gpt-5.5'])
    expect(await passthroughDenial('/v1/chat/completions', 'codex,gpt-5.5')).toContain('codex,gpt-5.5')
    // Sibling surfaces are untouched — the row is per-surface.
    expect((await resolveSurfaceForPath('/v1/responses'))?.deniedTargets).toEqual([])
    expect(await passthroughDenial('/v1/responses', 'codex,gpt-5.5')).toBeUndefined()
  })

  test('a write is reversible', async () => {
    await updateSurface({ surface: 'openai-chat', deniedTargets: ['codex,gpt-5.5'] })
    await updateSurface({ surface: 'openai-chat', deniedTargets: [] })
    expect((await resolveSurfaceForPath('/v1/chat/completions'))?.deniedTargets).toEqual([])
  })

  test('an unknown surface id is refused rather than written', async () => {
    // The id is a closed enum on the wire, but the service is also
    // reachable from code the schema does not guard, so the runtime
    // check has to hold on its own. The cast is what bypasses the
    // compile-time enum to reach it.
    const unknown = { surface: 'not-a-surface', deniedTargets: [] } as unknown as Parameters<typeof updateSurface>[0]
    await expect(updateSurface(unknown)).rejects.toThrow('Unknown inbound surface')
    expect(await getPrismaClient().inboundSurfaceConfig.count()).toBe(0)
  })
})
