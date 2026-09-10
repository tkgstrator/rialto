import { promises as fs } from 'node:fs'
import path from 'node:path'
import { OpenAPIHono } from '@hono/zod-openapi'
import { LOG_DIR } from '../../logger'

// Backend for LogViewer.tsx. The client (src/lib/api.ts) calls
// GET /api/logs/files, GET /api/logs?file=, DELETE /api/logs?file= —
// all behind the /api/* admin gate mounted in src/index.ts. Until
// now these routes did not exist, so the (fully built) log UI was
// dead. File logs are written by src/logger.ts as JSON lines.
export const logsRoute = new OpenAPIHono()

// Resolve a client-supplied `file` strictly inside LOG_DIR. basename()
// drops any path/.. segments; we still re-check the parent so a
// crafted value can never escape the logs directory.
function resolveLogFile(file: string | undefined): string | null {
  if (!file) return null
  const name = path.basename(file)
  if (!name || name.startsWith('.')) return null
  const resolved = path.resolve(LOG_DIR, name)
  if (path.dirname(resolved) !== path.resolve(LOG_DIR)) return null
  return resolved
}

logsRoute.get('/api/logs/files', async (c) => {
  let entries: string[]
  try {
    entries = await fs.readdir(LOG_DIR)
  } catch {
    return c.json([])
  }
  const files = await Promise.all(
    entries
      .filter((n) => n.endsWith('.log'))
      .map(async (name) => {
        const stat = await fs.stat(path.join(LOG_DIR, name)).catch(() => null)
        if (!stat) return null
        return {
          name,
          // Client echoes this back as ?file=, so keep it the bare
          // filename — resolveLogFile() re-roots it under LOG_DIR.
          path: name,
          size: stat.size,
          lastModified: stat.mtime.toISOString()
        }
      })
  )
  const list = files.filter((f): f is NonNullable<typeof f> => f !== null)
  list.sort((a, b) => b.lastModified.localeCompare(a.lastModified))
  return c.json(list)
})

// Cap the payload: a debug-level log file grows fast and the UI only
// needs the tail. Returns the last N non-empty lines, oldest first —
// LogViewer's worker JSON.parses each line and groups by reqId.
const MAX_LINES = 5000

logsRoute.get('/api/logs', async (c) => {
  const target = resolveLogFile(c.req.query('file'))
  if (!target) return c.json({ error: 'invalid file' }, 400)
  let content: string
  try {
    content = await fs.readFile(target, 'utf-8')
  } catch {
    return c.json([])
  }
  const lines = content.split('\n').filter((l) => l.trim().length > 0)
  return c.json(lines.slice(-MAX_LINES))
})

logsRoute.delete('/api/logs', async (c) => {
  const target = resolveLogFile(c.req.query('file'))
  if (!target) return c.json({ error: 'invalid file' }, 400)
  // Truncate rather than unlink: the active logger keeps appending to
  // today's file, and removing it out from under an open append would
  // just strand the handle.
  await fs.writeFile(target, '').catch(() => {})
  return c.body(null, 204)
})
