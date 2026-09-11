/**
 * Per-session detail routes: raw RequestLog rows (with computed cost)
 * and the archived chat message transcript.
 */

import { createRoute } from '@hono/zod-openapi'
import { getPrismaClient } from '../../db/client'
import {
  SessionIdParamSchema,
  SessionLogsQuerySchema,
  SessionLogsResponseSchema,
  SessionMessagesQuerySchema,
  SessionMessagesResponseSchema
} from '../../schemas/api/request-log'
import { buildPriceMap, computeCosts } from '../../services/cost-service'
import { requestLogsRoute } from './app'

// ── GET /api/request-logs/sessions/:sessionId ─────────────────────────────────
// One newest-first page of a session's upstream calls. It used to hand back
// every row at once, which a long agent session turns into thousands of
// priced rows for a screen that shows a few dozen.

const getSessionLogsRoute = createRoute({
  method: 'get',
  path: '/api/request-logs/sessions/:sessionId',
  request: { params: SessionIdParamSchema, query: SessionLogsQuerySchema },
  responses: {
    200: {
      description: 'One newest-first page of request logs for a specific session.',
      content: { 'application/json': { schema: SessionLogsResponseSchema } }
    }
  }
})

// ── GET /api/request-logs/sessions/:sessionId/messages ───────────────────────
// Archived chat messages for a session. Paged newest-first from the server's
// view — by `before` cursor or by `offset` — but each page is returned in
// ascending order so a chat-style client can render it top-to-bottom.
// Populated by the pipeline hook that captures the last user block on
// request send and the assembled assistant blocks after the response stream
// completes.

const getSessionMessagesRoute = createRoute({
  method: 'get',
  path: '/api/request-logs/sessions/:sessionId/messages',
  request: { params: SessionIdParamSchema, query: SessionMessagesQuerySchema },
  responses: {
    200: {
      description: 'Archived chat messages for the session, oldest first.',
      content: { 'application/json': { schema: SessionMessagesResponseSchema } }
    }
  }
})

requestLogsRoute.openapi(getSessionLogsRoute, async (c) => {
  const { sessionId } = c.req.valid('param')
  const { limit, offset } = c.req.valid('query')
  const prisma = getPrismaClient()
  const where = { sessionId }
  // `id` breaks createdAt ties so offset pages cannot overlap or skip: a
  // 429 and the failover that answered it can land in the same millisecond.
  const [total, logs] = await Promise.all([
    prisma.requestLog.count({ where }),
    prisma.requestLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: offset
    })
  ])
  const pairs = [...new Set(logs.map((l) => `${l.provider}||${l.model}`))]
  const priceMap = await buildPriceMap(prisma, pairs)
  const items = logs.map((log) => ({
    ...log,
    sessionId: log.sessionId,
    createdAt: log.createdAt.toISOString(),
    ...computeCosts(log, priceMap)
  }))
  return c.json({ items, total }, 200)
})

requestLogsRoute.openapi(getSessionMessagesRoute, async (c) => {
  const { sessionId } = c.req.valid('param')
  const { limit, offset, before } = c.req.valid('query')
  const prisma = getPrismaClient()

  // Descending walk from the newest end so pagination is anchored to the
  // most recent activity.
  // Composite (createdAt, id) order makes the cursor and the offset stable
  // when two rows share a timestamp.
  const [total, rows] = await Promise.all([
    prisma.message.count({ where: { sessionId } }),
    prisma.message.findMany({
      where: { sessionId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(before ? { cursor: { id: before }, skip: 1 } : { skip: offset }),
      take: limit + 1,
      select: { id: true, role: true, content: true, createdAt: true }
    })
  ])

  const hasMoreOlder = rows.length > limit
  const page = hasMoreOlder ? rows.slice(0, limit) : rows
  // Reverse to ascending so the client can render top-to-bottom.
  const items = [...page].reverse().map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    createdAt: r.createdAt.toISOString()
  }))
  const nextCursor = hasMoreOlder && items.length > 0 ? items[0].id : null
  return c.json({ items, nextCursor, total }, 200)
})
