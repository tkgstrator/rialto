/**
 * GET /health — public monitoring surface.
 *
 * Verifies the endpoint responds without a credential (uptime probes
 * don't carry one) and returns a machine-readable JSON envelope
 * rather than the SPA HTML that used to catch this path.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { healthRoute, summarizeHealth } from '../../src/api/health/route'
import { checkRedis } from '../../src/services/redis-health'

describe('GET /health', () => {
  test('returns 200 with a machine-readable envelope, no auth required', async () => {
    const res = await healthRoute.fetch(new Request('http://local/health'))
    // Bun test env has DATABASE_URL dropped in __tests__/setup.ts when
    // no TEST_DATABASE_URL is set, so the db check is either 'skip' or
    // 'ok'. Neither should make the endpoint 503.
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      status: 'ok' | 'degraded'
      version: string
      uptime_seconds: number
      checks: Record<string, 'ok' | 'fail' | 'skip'>
    }
    expect(body.status).toBe('ok')
    expect(typeof body.version).toBe('string')
    expect(body.version.length).toBeGreaterThan(0)
    expect(typeof body.uptime_seconds).toBe('number')
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0)
    expect(body.checks.db).toMatch(/^(ok|skip|fail)$/)
    // The Redis row on the Server screen read "not reported" forever
    // while this key was missing.
    expect(body.checks.redis).toMatch(/^(ok|skip|fail)$/)
  })

  test('response Content-Type is JSON (not HTML — the SPA fallback used to eat this path)', async () => {
    const res = await healthRoute.fetch(new Request('http://local/health'))
    expect(res.headers.get('content-type')?.startsWith('application/json')).toBe(true)
  })
})

describe('summarizeHealth', () => {
  test('everything up is ok / 200', () => {
    expect(summarizeHealth({ db: 'ok', redis: 'ok' })).toEqual({ status: 'ok', code: 200 })
    expect(summarizeHealth({ db: 'skip', redis: 'skip' })).toEqual({ status: 'ok', code: 200 })
  })

  test('a failed REQUIRED check is 503', () => {
    expect(summarizeHealth({ db: 'fail', redis: 'ok' })).toEqual({ status: 'degraded', code: 503 })
  })

  /**
   * The reason Redis is not in REQUIRED_CHECKS: usage capture and the
   * auth-health job stopping is worth showing an operator, but the proxy
   * serves every request without them. A 503 here would pull a healthy
   * instance out of a load balancer over a background job.
   */
  test('a failed optional check is visible but still serving', () => {
    expect(summarizeHealth({ db: 'ok', redis: 'fail' })).toEqual({ status: 'degraded', code: 200 })
  })
})

describe('checkRedis', () => {
  const original = process.env.REDIS_URL

  afterEach(() => {
    if (original === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = original
  })

  test("an unwired Redis is 'skip', not 'fail'", async () => {
    delete process.env.REDIS_URL
    expect(await checkRedis()).toBe('skip')
  })

  test('an unreachable Redis answers fail rather than hanging', async () => {
    // Port 1 refuses immediately; the point is that the probe resolves
    // at all — it gets one attempt and a hard timeout, so it can never
    // outlive the response it describes.
    process.env.REDIS_URL = 'redis://127.0.0.1:1'
    const started = Date.now()
    expect(await checkRedis()).toBe('fail')
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
