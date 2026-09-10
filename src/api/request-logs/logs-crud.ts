/**
 * Flat request-log routes: paginated list, archive-all, and delete-one.
 */

import { createRoute } from '@hono/zod-openapi'
import { getPrismaClient } from '../../db/client'
import dayjs from '../../lib/dayjs'
import {
  RequestLogIdParamSchema,
  RequestLogsDeleteOneResponseSchema,
  RequestLogsListQuerySchema,
  RequestLogsListResponseSchema,
  SessionsArchiveResponseSchema
} from '../../schemas/api/request-log'
import { buildPriceMap, computeCosts } from '../../services/cost-service'
import { requestLogsRoute } from './app'

// ── GET /api/request-logs ─────────────────────────────────────────────────────

const getRequestLogsRoute = createRoute({
  method: 'get',
  path: '/api/request-logs',
  request: {
    query: RequestLogsListQuerySchema
  },
  responses: {
    200: {
      description: 'Paginated list of LLM request stats.',
      content: { 'application/json': { schema: RequestLogsListResponseSchema } }
    }
  }
})

requestLogsRoute.openapi(getRequestLogsRoute, async (c) => {
  const { limit, offset, sinceHours } = c.req.valid('query')
  const prisma = getPrismaClient()
  // `total` counts the same population the page is drawn from, so the
  // screen can say "25 of 18,742 in the last 24h" without the two halves
  // of that sentence coming from different windows. Rides
  // `@@index([createdAt])`.
  const where = sinceHours === 0 ? {} : { createdAt: { gte: dayjs().subtract(sinceHours, 'hour').toDate() } }
  const [total, logs] = await Promise.all([
    prisma.requestLog.count({ where }),
    prisma.requestLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset })
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

// ── POST /api/request-logs/sessions/archive ───────────────────────────────────
// Soft-clears the History list: marks every active session as archived so it
// drops out of the sessions list, while leaving its RequestLog rows intact so
// the Usage/cost totals (weekly, all-time) are preserved. A session reappears
// automatically once it receives new activity (the upsert resets archivedAt).

requestLogsRoute.openapi(
  createRoute({
    method: 'post',
    path: '/api/request-logs/sessions/archive',
    responses: {
      200: {
        description: 'All active sessions archived.',
        content: { 'application/json': { schema: SessionsArchiveResponseSchema } }
      }
    }
  }),
  async (c) => {
    const prisma = getPrismaClient()
    const { count } = await prisma.session.updateMany({
      where: { archivedAt: null },
      data: { archivedAt: new Date() }
    })
    return c.json({ archived: count }, 200)
  }
)

// ── DELETE /api/request-logs/:id ──────────────────────────────────────────────

requestLogsRoute.openapi(
  createRoute({
    method: 'delete',
    path: '/api/request-logs/:id',
    request: { params: RequestLogIdParamSchema },
    responses: {
      200: {
        description: 'Deleted.',
        content: { 'application/json': { schema: RequestLogsDeleteOneResponseSchema } }
      }
    }
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    await getPrismaClient().requestLog.delete({ where: { id } })
    return c.json({ id }, 200)
  }
)
