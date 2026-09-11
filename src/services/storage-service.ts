/**
 * How much disk the archives actually occupy, and a way to shrink them.
 *
 * RequestLog and Message grow with every request and nothing prunes
 * them, so the honest first step is showing the operator the number.
 * UsageSnapshot already self-prunes on the usage job's tick; it is
 * listed here so all four stores read from one place.
 *
 * Sizes come from `pg_total_relation_size`, which counts indexes and
 * TOAST as well as the heap — the number an operator sees in `df` — not
 * from row counts multiplied by a guess.
 *
 * Stores are identified by id only. What a store is called is the UI's
 * business and is translated there; a table name here used to reach the
 * screen verbatim.
 */

import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { getPrismaClient } from '../db/client'
import dayjs from '../lib/dayjs'
import { LOG_DIR } from '../shared/constants'

export type StoreId = 'requestLog' | 'message' | 'usageSnapshot' | 'logFiles'

export interface StoreStats {
  id: StoreId
  /** Rows for a table, files for the log-file store. */
  count: number
  bytes: number
}

export interface StorageStats {
  stores: StoreStats[]
  generatedAt: string
}

// Store id → table. Kept explicit rather than derived so a renamed model
// cannot silently start pruning the wrong table.
const TABLES: Array<{ id: StoreId; table: string }> = [
  { id: 'requestLog', table: 'RequestLog' },
  { id: 'message', table: 'Message' },
  { id: 'usageSnapshot', table: 'UsageSnapshot' }
]

async function tableBytes(table: string): Promise<number> {
  const rows = await getPrismaClient().$queryRawUnsafe<Array<{ bytes: bigint }>>(
    'SELECT pg_total_relation_size($1::regclass) AS bytes',
    `"${table}"`
  )
  return rows.length === 0 ? 0 : Number(rows[0].bytes)
}

async function logFileStats(): Promise<{ count: number; bytes: number }> {
  const names = await readdir(LOG_DIR).catch(() => [])
  const sizes = await Promise.all(
    names
      .filter((n) => n.endsWith('.log'))
      .map((n) =>
        stat(join(LOG_DIR, n))
          .then((s) => s.size)
          .catch(() => 0)
      )
  )
  return { count: sizes.length, bytes: sizes.reduce((a, b) => a + b, 0) }
}

export async function getStorageStats(): Promise<StorageStats> {
  const prisma = getPrismaClient()
  const [requestLogRows, messageRows, usageRows, sizes, logs] = await Promise.all([
    prisma.requestLog.count(),
    prisma.message.count(),
    prisma.usageSnapshot.count(),
    Promise.all(TABLES.map((t) => tableBytes(t.table))),
    logFileStats()
  ])
  const rowCounts: Record<string, number> = {
    requestLog: requestLogRows,
    message: messageRows,
    usageSnapshot: usageRows
  }

  const stores: StoreStats[] = TABLES.map((t, i) => ({ id: t.id, count: rowCounts[t.id], bytes: sizes[i] }))

  stores.push({ id: 'logFiles', count: logs.count, bytes: logs.bytes })

  return { stores, generatedAt: dayjs().toISOString() }
}

export interface PruneResult {
  store: StoreId
  deleted: number
}

/**
 * Delete everything in a store older than `olderThanDays`.
 *
 * Destructive and irreversible, so the cutoff is always explicit — there
 * is no "prune to the default", because the stores that most need
 * pruning are exactly the ones with no default to fall back on.
 * Archived RequestLog rows still back the Usage and cost totals, so
 * pruning them lowers historical spend figures; that is the operator's
 * call to make deliberately.
 */
export async function pruneStore(store: StoreId, olderThanDays: number): Promise<PruneResult> {
  const cutoff = dayjs().subtract(olderThanDays, 'day').toDate()
  const prisma = getPrismaClient()

  if (store === 'requestLog') {
    const { count } = await prisma.requestLog.deleteMany({ where: { createdAt: { lt: cutoff } } })
    return { store, deleted: count }
  }
  if (store === 'message') {
    const { count } = await prisma.message.deleteMany({ where: { createdAt: { lt: cutoff } } })
    return { store, deleted: count }
  }
  if (store === 'usageSnapshot') {
    const { count } = await prisma.usageSnapshot.deleteMany({ where: { capturedAt: { lt: cutoff } } })
    return { store, deleted: count }
  }

  const names = await readdir(LOG_DIR).catch(() => [])
  const cutoffMs = cutoff.getTime()
  const removed = await Promise.all(
    names
      .filter((n) => n.endsWith('.log'))
      .map(async (n) => {
        const path = join(LOG_DIR, n)
        const info = await stat(path).catch(() => null)
        if (info === null || info.mtimeMs >= cutoffMs) return 0
        const ok = await unlink(path).then(
          () => 1,
          () => 0
        )
        return ok
      })
  )
  return { store, deleted: removed.reduce((a, b) => a + b, 0) }
}
