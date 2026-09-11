/**
 * GET /api/storage, POST /api/storage/prune.
 *
 * RequestLog and Message grow with every request and nothing bounds
 * them; before this the only way to learn that was to run out of disk.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { getStorageStats, pruneStore } from '../../services/storage-service'

const StoreIdSchema = z.enum(['requestLog', 'message', 'usageSnapshot', 'logFiles'])

const StoreSchema = z
  .object({
    id: StoreIdSchema,
    // Rows for a table, files for the log-file store.
    count: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative()
  })
  .openapi('StorageStore')

const StatsSchema = z
  .object({ stores: z.array(StoreSchema), generatedAt: z.string().nonempty() })
  .openapi('StorageStats')

const PruneBodySchema = z
  .object({
    store: StoreIdSchema,
    // Explicit on every call. The stores that most need pruning are the
    // ones with no retention default, so there is nothing safe to
    // fall back to — the caller has to say what it means to delete.
    olderThanDays: z.number().int().positive().max(3650)
  })
  .openapi('StoragePruneRequest')

const PruneResultSchema = z
  .object({ store: StoreIdSchema, deleted: z.number().int().nonnegative() })
  .openapi('StoragePruneResult')

export const storageRoute = new OpenAPIHono()

storageRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/storage',
    responses: {
      200: {
        description: 'Row counts and on-disk size per archive store',
        content: { 'application/json': { schema: StatsSchema } }
      }
    }
  }),
  async (c) => c.json(await getStorageStats(), 200)
)

storageRoute.openapi(
  createRoute({
    method: 'post',
    path: '/api/storage/prune',
    request: { body: { content: { 'application/json': { schema: PruneBodySchema } } } },
    responses: {
      200: {
        description: 'Rows (or files) deleted. Irreversible.',
        content: { 'application/json': { schema: PruneResultSchema } }
      }
    }
  }),
  async (c) => {
    const { store, olderThanDays } = c.req.valid('json')
    return c.json(await pruneStore(store, olderThanDays), 200)
  }
)
