/**
 * Session list + per-session summary routes: aggregates RequestLog rows
 * grouped by Session, joined with the cost map and chat preview.
 */

import { createRoute } from '@hono/zod-openapi'
import { getPrismaClient } from '../../db/client'
import dayjs from '../../lib/dayjs'
import {
  RequestLogsSessionsQuerySchema,
  SessionIdParamSchema,
  SessionSummarySchema,
  SessionsResponseSchema
} from '../../schemas/api/request-log'
import { buildPriceMap, computeCosts } from '../../services/cost-service'
import { requestLogsRoute } from './app'
import { loadPreviews } from './preview'

// Narrow the Session.inboundType text column (typed `string | null` by
// Prisma) to the discriminated union the wire schema expects. Anything
// unrecognised — including the null on pre-migration rows — surfaces as
// null so the History view treats it as "unknown" rather than falsely
// bucketed. Kept as a helper so TypeScript picks up the narrowing at
// the object-literal assignment site.
function narrowInboundType(raw: string | null): 'anthropic' | 'openai' | 'gemini' | null {
  if (raw === 'anthropic' || raw === 'openai' || raw === 'gemini') return raw
  return null
}

// A session's surface, taken from its most recent request. Sessions do
// not carry the column themselves — Session predates it — and in practice
// a session stays on one surface for its whole life, so the newest row is
// the session's surface. Null when nothing in the session was tracked.
function latestSurface(logs: Array<{ surface: string | null; createdAt: Date }>): string | null {
  const tracked = logs.filter((l) => l.surface !== null)
  if (tracked.length === 0) return null
  const newest = tracked.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b))
  return newest.surface
}

/**
 * Which models a session used, busiest first.
 *
 * A session is not one model — routing moves it between them turn by
 * turn, and on a demo install 45 of 56 sessions used two or more. This
 * used to be `[...new Set(logs.map(l => l.model))]` over an include with
 * no `orderBy`, so the entry the list screen displayed as "the" model
 * was whichever row Postgres happened to return first, and could differ
 * between two loads of the same page. Ties break on the name so the
 * order is total.
 */
export const modelUsage = (logs: ReadonlyArray<{ model: string }>): Array<{ name: string; requests: number }> => {
  const counts = new Map<string, number>()
  for (const log of logs) {
    const prev = counts.get(log.model)
    counts.set(log.model, prev === undefined ? 1 : prev + 1)
  }
  return [...counts]
    .map(([name, requests]) => ({ name, requests }))
    .sort((a, b) => (b.requests === a.requests ? a.name.localeCompare(b.name) : b.requests - a.requests))
}

// ── GET /api/request-logs/sessions ───────────────────────────────────────────

const getSessionsRoute = createRoute({
  method: 'get',
  path: '/api/request-logs/sessions',
  request: {
    query: RequestLogsSessionsQuerySchema
  },
  responses: {
    200: {
      description: 'LLM request sessions with aggregated stats.',
      content: {
        'application/json': { schema: SessionsResponseSchema }
      }
    }
  }
})

// ── GET /api/request-logs/sessions/:sessionId/summary ────────────────────────
// Returns the aggregated SessionSummary for a single session without loading
// all logs. Used by the SSE handler to patch the client list in-place.

const getSessionSummaryRoute = createRoute({
  method: 'get',
  path: '/api/request-logs/sessions/:sessionId/summary',
  request: { params: SessionIdParamSchema },
  responses: {
    200: {
      description: 'Aggregated stats for a single session.',
      content: { 'application/json': { schema: SessionSummarySchema } }
    },
    404: { description: 'Session not found.' }
  }
})

requestLogsRoute.openapi(getSessionsRoute, async (c) => {
  const { limit, offset, sinceHours, inboundType } = c.req.valid('query')
  const prisma = getPrismaClient()

  // Limit to sessions active within the recent window (0 = no limit) so the
  // History list doesn't grow unbounded. Archived sessions are always hidden
  // — their RequestLog rows still count toward the Usage/cost totals.
  // `inboundType` filter narrows to Claude Code vs OpenAI-compat sessions;
  // when omitted the list mixes both. Pre-migration rows (inboundType null)
  // are excluded from a filtered view rather than falsely bucketed.
  const since = sinceHours > 0 ? dayjs().subtract(sinceHours, 'hour').toDate() : null
  const where = {
    archivedAt: null,
    ...(since ? { updatedAt: { gte: since } } : {}),
    ...(inboundType ? { inboundType } : {})
  }

  // Sessions from the Session table (ordered by most-recently-updated first)
  const [total, sessionRows] = await Promise.all([
    prisma.session.count({ where }),
    prisma.session.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: offset,
      take: limit,
      include: {
        logs: {
          select: {
            provider: true,
            model: true,
            surface: true,
            inputTokens: true,
            outputTokens: true,
            cacheReadTokens: true,
            cacheWriteTokens: true,
            totalInputTokens: true,
            cacheHitPct: true,
            durationMs: true,
            createdAt: true
          }
        }
      }
    })
  ])

  // Collect all provider+model pairs for a single price-map lookup
  const allPairs = [...new Set(sessionRows.flatMap((s) => s.logs.map((l) => `${l.provider}||${l.model}`)))]
  const [priceMap, previewMap] = await Promise.all([
    buildPriceMap(prisma, allPairs),
    loadPreviews(sessionRows.map((s) => s.id))
  ])

  const sessions = sessionRows.map((s) => {
    const logs = s.logs
    const providers = [...new Set(logs.map((l) => l.provider))]
    const models = modelUsage(logs)
    const totalInputTokens = logs.reduce((a, l) => a + l.totalInputTokens, 0)
    const totalOutputTokens = logs.reduce((a, l) => a + l.outputTokens, 0)
    const totalCacheReadTokens = logs.reduce((a, l) => a + l.cacheReadTokens, 0)
    const totalCacheWriteTokens = logs.reduce((a, l) => a + l.cacheWriteTokens, 0)
    const totalDurationMs = logs.reduce((a, l) => a + l.durationMs, 0)
    const avgCacheHitPct = logs.length > 0 ? Math.round(logs.reduce((a, l) => a + l.cacheHitPct, 0) / logs.length) : 0
    const dates = logs.map((l) => l.createdAt.getTime())
    const firstAt = dates.length > 0 ? new Date(Math.min(...dates)).toISOString() : s.createdAt.toISOString()
    const lastAt = dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : s.updatedAt.toISOString()

    // Aggregate cost across all logs in the session
    let totalCostUsd: number | null = null
    for (const log of logs) {
      const { totalCostUsd: c } = computeCosts(log, priceMap)
      if (c != null) totalCostUsd = (totalCostUsd ?? 0) + c
    }

    return {
      sessionId: s.id,
      inboundType: narrowInboundType(s.inboundType),
      surface: latestSurface(logs),
      requestCount: logs.length,
      providers,
      models,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheWriteTokens,
      avgCacheHitPct,
      totalDurationMs,
      totalCostUsd,
      firstAt,
      lastAt,
      preview: previewMap.get(s.id) ?? null
    }
  })

  return c.json({ sessions, total }, 200)
})

requestLogsRoute.openapi(getSessionSummaryRoute, async (c) => {
  const { sessionId } = c.req.valid('param')
  const prisma = getPrismaClient()

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      logs: {
        select: {
          provider: true,
          model: true,
          surface: true,
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          totalInputTokens: true,
          cacheHitPct: true,
          durationMs: true,
          createdAt: true
        }
      }
    }
  })

  if (!session) return c.json({ error: 'Not found' } as never, 404)

  const logs = session.logs
  const pairs = [...new Set(logs.map((l) => `${l.provider}||${l.model}`))]
  const [priceMap, previewMap] = await Promise.all([buildPriceMap(prisma, pairs), loadPreviews([sessionId])])

  const providers = [...new Set(logs.map((l) => l.provider))]
  const models = modelUsage(logs)
  const totalInputTokens = logs.reduce((a, l) => a + l.totalInputTokens, 0)
  const totalOutputTokens = logs.reduce((a, l) => a + l.outputTokens, 0)
  const totalCacheReadTokens = logs.reduce((a, l) => a + l.cacheReadTokens, 0)
  const totalCacheWriteTokens = logs.reduce((a, l) => a + l.cacheWriteTokens, 0)
  const totalDurationMs = logs.reduce((a, l) => a + l.durationMs, 0)
  const avgCacheHitPct = logs.length > 0 ? Math.round(logs.reduce((a, l) => a + l.cacheHitPct, 0) / logs.length) : 0
  const dates = logs.map((l) => l.createdAt.getTime())
  const firstAt = dates.length > 0 ? new Date(Math.min(...dates)).toISOString() : session.createdAt.toISOString()
  const lastAt = dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : session.updatedAt.toISOString()

  let totalCostUsd: number | null = null
  for (const log of logs) {
    const { totalCostUsd: c } = computeCosts(log, priceMap)
    if (c != null) totalCostUsd = (totalCostUsd ?? 0) + c
  }

  return c.json(
    {
      sessionId,
      inboundType: narrowInboundType(session.inboundType),
      surface: latestSurface(logs),
      requestCount: logs.length,
      providers,
      models,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheWriteTokens,
      avgCacheHitPct,
      totalDurationMs,
      totalCostUsd,
      firstAt,
      lastAt,
      preview: previewMap.get(sessionId) ?? null
    },
    200
  )
})
