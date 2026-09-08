/**
 * GET /health — public monitoring endpoint.
 *
 * Deliberately outside the APIKEY gate so uptime probes and k8s
 * liveness/readiness checks don't need to carry a secret. Runs one
 * cheap reachability check per dependency, in parallel; each one skips
 * itself (`'skip'`) when the dependency isn't wired at all (test /
 * bootstrap environments) so the endpoint stays green during first-run
 * seed.
 *
 * Response shape:
 *   {
 *     status: 'ok' | 'degraded',
 *     version: '<APP_VERSION>',
 *     uptime_seconds: <int>,
 *     checks: { db: 'ok' | 'fail' | 'skip', redis: 'ok' | 'fail' | 'skip' }
 *   }
 *
 * Status code: 200 while this instance can still serve requests, 503
 * when a REQUIRED dependency failed. `status` and the code are not the
 * same question — see REQUIRED_CHECKS.
 */

import { Hono } from 'hono'
import { getPrismaClient } from '../../db/client'
import { type CheckState, checkRedis } from '../../services/redis-health'
import { APP_VERSION } from '../../version'

const bootedAt = Math.floor(Date.now() / 1000)

/**
 * The dependencies that decide the HTTP code.
 *
 * A probe reads the code; a human reads `status`. Redis is deliberately
 * absent: both jobs that use it are fire-and-forget and every proxied
 * request is served without it, so a downed Redis must not pull the
 * instance out of a load balancer. It still reports `fail` and still
 * drags `status` to 'degraded', which is what makes it visible on the
 * Server screen.
 */
const REQUIRED_CHECKS: readonly string[] = ['db']

export function summarizeHealth(checks: Record<string, CheckState>): {
  status: 'ok' | 'degraded'
  code: 200 | 503
} {
  const failed = Object.entries(checks)
    .filter(([, state]) => state === 'fail')
    .map(([name]) => name)
  return {
    status: failed.length === 0 ? 'ok' : 'degraded',
    code: failed.some((name) => REQUIRED_CHECKS.includes(name)) ? 503 : 200
  }
}

async function checkDb(): Promise<CheckState> {
  if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL.length === 0) return 'skip'
  try {
    // biome-ignore plugin: the Prisma raw tag needs a bound `this`, which the tagged-template call provides directly. Wrapped in try/catch so a downed DB flips the check to 'fail' rather than throwing to the caller.
    await getPrismaClient().$queryRaw`SELECT 1`
    return 'ok'
  } catch {
    return 'fail'
  }
}

export const healthRoute = new Hono()

healthRoute.get('/health', async (c) => {
  // In parallel: the endpoint's latency is one round trip, not the sum
  // of however many dependencies get added here later.
  const [db, redis] = await Promise.all([checkDb(), checkRedis()])
  const checks: Record<string, CheckState> = { db, redis }

  const { status, code } = summarizeHealth(checks)
  return c.json(
    {
      status,
      version: APP_VERSION,
      uptime_seconds: Math.floor(Date.now() / 1000) - bootedAt,
      checks
    },
    code
  )
})
