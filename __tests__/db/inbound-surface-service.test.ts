/**
 * The routing-mode override is the one place where a stored row changes
 * how every /v1 request is dispatched, so these tests pin the two things
 * that must not drift: the shipped defaults reproduce the pre-Rialto
 * hardcoded behaviour, and an override actually takes effect on the hot
 * path (which reads through a cache).
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import {
  ensureInboundSurfaces,
  invalidateSurfaceCache,
  isRoutedPath,
  listSurfaces,
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

  test('seeding gives every surface an explicit stored mode', async () => {
    await ensureInboundSurfaces()
    const rows = await getPrismaClient().inboundSurfaceConfig.findMany()
    expect(rows).toHaveLength(5)
    // No surface is more default than another: they all start the same.
    expect(rows.every((r) => r.routingMode === 'passthrough')).toBe(true)
  })

  test('seeding is idempotent and never rewrites a chosen mode', async () => {
    await ensureInboundSurfaces()
    await updateSurface({ surface: 'anthropic-messages', routingMode: 'routed' })
    await ensureInboundSurfaces()
    expect(await isRoutedPath('/v1/messages')).toBe(true)
  })

  test('an unseeded surface reads as passthrough rather than inventing a default', async () => {
    const byId = new Map((await listSurfaces()).map((s) => [s.id, s]))
    expect([...byId.values()].every((s) => s.routingMode === 'passthrough')).toBe(true)
  })

  test('an unknown path stays routed rather than silently bypassing the router', async () => {
    expect(await isRoutedPath('/v1/something-new')).toBe(true)
    expect(await isRoutedPath(undefined)).toBe(true)
  })

  test('the gemini surface resolves from a model-and-action path', async () => {
    const surface = await resolveSurfaceForPath('/v1beta/models/gemini-3-pro:streamGenerateContent')
    expect(surface?.id).toBe('gemini-generate')
  })

  test('a mode change takes effect on the hot path, which reads through a cache', async () => {
    await updateSurface({ surface: 'openai-chat', routingMode: 'routed' })

    expect(await isRoutedPath('/v1/chat/completions')).toBe(true)
    expect((await resolveSurfaceForPath('/v1/chat/completions'))?.routingMode).toBe('routed')
    // Sibling surfaces are untouched — the row is per-surface.
    expect(await isRoutedPath('/v1/responses')).toBe(false)
  })

  test('a mode change is reversible', async () => {
    await updateSurface({ surface: 'openai-chat', routingMode: 'routed' })
    await updateSurface({ surface: 'openai-chat', routingMode: 'passthrough' })
    expect((await resolveSurfaceForPath('/v1/chat/completions'))?.routingMode).toBe('passthrough')
  })

  test('a surface carries the default profile key until one is chosen', async () => {
    const before = await resolveSurfaceForPath('/v1/messages')
    expect(before?.profileKey).toBe('live')

    await updateSurface({ surface: 'anthropic-messages', routingMode: 'routed', profileKey: 'cost-first' })
    const after = await resolveSurfaceForPath('/v1/messages')
    expect(after?.profileKey).toBe('cost-first')
  })

  test('an unknown surface id is refused rather than written', async () => {
    // The id is a closed enum on the wire, but the service is also
    // reachable from code the schema does not guard, so the runtime
    // check has to hold on its own. The cast is what bypasses the
    // compile-time enum to reach it.
    const unknown = { surface: 'not-a-surface', routingMode: 'routed' } as unknown as Parameters<
      typeof updateSurface
    >[0]
    await expect(updateSurface(unknown)).rejects.toThrow('Unknown inbound surface')
    expect(await getPrismaClient().inboundSurfaceConfig.count()).toBe(0)
  })
})
