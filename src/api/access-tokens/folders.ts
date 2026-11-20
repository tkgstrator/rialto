import { z } from '@hono/zod-openapi'
import { Hono } from 'hono'
import { getPrismaClient } from '../../db/client'
import { Prisma } from '../../generated/prisma/client'
import { TOKEN_PROVIDER_MODES } from '../../shared/access-token-policy'

const FolderSchema = z.object({
  name: z.string().trim().min(1).max(100),
  parentId: z.string().nonempty().nullable(),
  defaultPlanId: z.string().nonempty().nullable(),
  defaultProviderMode: z.enum(TOKEN_PROVIDER_MODES),
  defaultProviderFallback: z.boolean()
})

export const tokenFoldersRoute = new Hono()

tokenFoldersRoute.get('/api/access-token-folders', async (c) =>
  c.json({ folders: await getPrismaClient().accessTokenFolder.findMany({ orderBy: [{ name: 'asc' }, { id: 'asc' }] }) })
)

function folderConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && ['P2003', 'P2025'].includes(error.code)
}

tokenFoldersRoute.on(['POST', 'PUT'], ['/api/access-token-folders', '/api/access-token-folders/:id'], async (c) => {
  const id = c.req.param('id')
  if ((c.req.method === 'POST') !== (id === undefined)) return c.notFound()
  const parsed = FolderSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid folder settings.' }, 400)

  try {
    const folder = await getPrismaClient().$transaction(async (tx) => {
      // Serialize tree edits so concurrent moves cannot create a cycle.
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(726138, 96831)`
      const rows = await tx.accessTokenFolder.findMany({ select: { id: true, parentId: true } })
      const parents = new Map(rows.map((row) => [row.id, row.parentId]))
      const next = { parentId: parsed.data.parentId }
      for (const _row of rows) {
        if (next.parentId === null) break
        const parent = parents.get(next.parentId)
        if (next.parentId === id || parent === undefined) return null
        next.parentId = parent
      }
      if (next.parentId !== null) return null
      return id === undefined
        ? tx.accessTokenFolder.create({ data: parsed.data })
        : tx.accessTokenFolder.update({ where: { id }, data: parsed.data })
    })
    return folder === null ? c.json({ error: 'Invalid parent folder.' }, 400) : c.json(folder)
  } catch (error) {
    if (folderConflict(error)) return c.json({ error: 'Folder or plan no longer exists.' }, 409)
    throw error
  }
})

tokenFoldersRoute.delete('/api/access-token-folders/:id', async (c) => {
  try {
    await getPrismaClient().accessTokenFolder.delete({ where: { id: c.req.param('id') } })
    return c.json({ deleted: true })
  } catch (error) {
    if (folderConflict(error)) return c.json({ error: 'Folder must exist and be empty.' }, 409)
    throw error
  }
})
