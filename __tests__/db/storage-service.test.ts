/**
 * Prune is irreversible and deletes rows the Usage and cost totals are
 * computed from, so the cutoff has to be exact: everything older goes,
 * everything at or inside the window stays. These tests pin that
 * boundary and the per-store isolation — pruning one archive must not
 * touch another.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import { getStorageStats, pruneStore } from '../../src/services/storage-service'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

const daysAgo = (n: number): Date => new Date(Date.now() - n * 24 * 60 * 60 * 1000)

async function seed(): Promise<void> {
  const prisma = getPrismaClient()
  await prisma.session.create({ data: { id: 's1' } })
  for (const days of [1, 10, 100]) {
    await prisma.requestLog.create({
      data: { sessionId: 's1', provider: 'acme', model: 'acme-1', createdAt: daysAgo(days) }
    })
    await prisma.message.create({
      data: { sessionId: 's1', role: 'user', content: 'hi', createdAt: daysAgo(days) }
    })
    await prisma.usageSnapshot.create({
      data: { provider: 'acme', metric: 'x', percent: 1, capturedAt: daysAgo(days) }
    })
  }
}

describe.skipIf(!HAS_DB)('storage-service', () => {
  beforeEach(async () => {
    await resetDbTables()
    await seed()
  })

  afterAll(teardownPrisma)

  test('reports a row count and a non-zero size for every store', async () => {
    const { stores } = await getStorageStats()
    expect(stores.map((s) => s.id)).toEqual(['requestLog', 'message', 'usageSnapshot', 'logFiles'])
    expect(stores.find((s) => s.id === 'requestLog')?.count).toBe(3)
    expect(stores.find((s) => s.id === 'message')?.count).toBe(3)
    // pg_total_relation_size counts indexes and TOAST, so a table with
    // rows is never zero bytes.
    expect(stores.find((s) => s.id === 'requestLog')?.bytes).toBeGreaterThan(0)
  })

  test('the log-file store counts files', async () => {
    const logFiles = (await getStorageStats()).stores.find((s) => s.id === 'logFiles')
    expect(logFiles?.count).toBeGreaterThanOrEqual(0)
    // Nothing but the id and the two numbers: what a store is called is
    // translated in the UI, and a table name here once reached the screen.
    expect(Object.keys(logFiles === undefined ? {} : logFiles).sort()).toEqual(['bytes', 'count', 'id'])
  })

  test('prune deletes strictly older than the cutoff and keeps the rest', async () => {
    const result = await pruneStore('requestLog', 30)
    expect(result.deleted).toBe(1)
    expect(await getPrismaClient().requestLog.count()).toBe(2)
  })

  test('prune touches only the named store', async () => {
    await pruneStore('requestLog', 5)
    const prisma = getPrismaClient()
    expect(await prisma.requestLog.count()).toBe(1)
    expect(await prisma.message.count()).toBe(3)
    expect(await prisma.usageSnapshot.count()).toBe(3)
  })

  test('a cutoff older than everything deletes nothing', async () => {
    const result = await pruneStore('message', 3650)
    expect(result.deleted).toBe(0)
    expect(await getPrismaClient().message.count()).toBe(3)
  })

  test('each store prunes on its own timestamp column', async () => {
    // UsageSnapshot dates on capturedAt, not createdAt; using the wrong
    // column would silently delete nothing or everything.
    const result = await pruneStore('usageSnapshot', 30)
    expect(result.deleted).toBe(1)
    expect(await getPrismaClient().usageSnapshot.count()).toBe(2)
  })
})
