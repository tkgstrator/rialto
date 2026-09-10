/**
 * Parity matrix — the "failover / 429" row.
 *
 * **One implementation** serves all four surfaces here. Building the
 * chain (`buildFailoverChain`), classifying a 429 (`isRateLimited` /
 * `isInsufficientQuota`) and rotating accounts never look at the
 * surface. The only thing that varies is the envelope the failure comes
 * back in.
 *
 * So this row is backed not by "each surface works separately" but by
 * **"no surface differs"**. The one place they could — a fallback is
 * only resolved on a surface where routing is on — is covered by
 * `__tests__/parity/routing-mode.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { HTTPException } from 'hono/http-exception'
import { buildFailoverChain } from '../../src/api/v1/candidate-chain'
import { errorShapeForPath } from '../../src/api/v1/error-shape'
import type { RoutePlan } from '../../src/api/v1/route-plan'
import { forwardUpstreamError, isInsufficientQuota, isRateLimited } from '../../src/api/v1/upstream-error'
import { OpenAITransformer } from '../../src/llms/transformers/openai'

const SURFACE_PATHS: readonly string[] = [
  '/v1/messages',
  '/v1/chat/completions',
  '/v1/responses',
  '/v1beta/models/gemini-3-pro:generateContent'
]

const planFor = (path: string, fallbacks: readonly string[]): RoutePlan => ({
  routedBody: { model: 'sub,fable' },
  headers: {},
  transformersByName: new Map(),
  defaultTransformer: new OpenAITransformer(),
  scenarioType: 'default',
  primaryModel: 'sub,fable',
  isSubagent: false,
  fallbacks,
  path,
  search: '',
  accountSessionKey: 'anonymous'
})

const upstream429 = (rawBody: string): HTTPException =>
  new HTTPException(429 as never, { message: `Error from provider(sub,fable: 429): ${rawBody}` })

describe('building the chain does not depend on the surface', () => {
  test('the same plan yields the same candidate list on all four', () => {
    const chains = SURFACE_PATHS.map((path) => buildFailoverChain(planFor(path, ['sub,opus'])))
    for (const chain of chains) expect(chain).toEqual(['sub,fable', 'sub,opus'])
  })

  test('a subscription primary keeps an api_key fallback on every surface, in chain order', () => {
    // The chain is the operator's own statement of what may follow
    // what; there is no auth-mode gate that could read it differently
    // per surface.
    for (const path of SURFACE_PATHS) {
      expect(buildFailoverChain(planFor(path, ['paid,opus']))).toEqual(['sub,fable', 'paid,opus'])
    }
  })

  test('falling back to another model on the same provider is kept (fable → opus)', () => {
    expect(buildFailoverChain(planFor('/v1/messages', ['sub,opus', 'sub,fable']))).toEqual(['sub,fable', 'sub,opus'])
  })
})

describe('classifying a 429 does not depend on the surface', () => {
  test('a 429 is a failover', () => {
    expect(isRateLimited(upstream429('{"type":"error"}'))).toBe(true)
  })

  test('400 and 401 do not fail over, so a real problem is not hidden', () => {
    expect(isRateLimited(new HTTPException(400 as never, { message: 'Error from provider(p,m: 400): x' }))).toBe(false)
    expect(isRateLimited(new HTTPException(401 as never, { message: 'Error from provider(p,m: 401): x' }))).toBe(false)
  })

  test('insufficient_quota is a permanent limit and detaches the whole provider', () => {
    const err = upstream429(JSON.stringify({ error: { type: 'insufficient_quota', message: 'quota' } }))
    expect(isRateLimited(err)).toBe(true)
    expect(isInsufficientQuota(err)).toBe(true)
  })
})

describe('a 429 after the chain is exhausted comes back in the surface envelope', () => {
  const RATE_LIMIT_BODY = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })

  test('each surface receives the 429 in a shape its own SDK can read', async () => {
    const bodies = await Promise.all(
      SURFACE_PATHS.map(async (path) => {
        const forwarded = forwardUpstreamError(upstream429(RATE_LIMIT_BODY), errorShapeForPath(path), 'sub')
        expect(forwarded?.status).toBe(429)
        return await forwarded!.json()
      })
    )
    expect(bodies[0]).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: '[via sub] slow down' }
    })
    expect(bodies[1]).toEqual({
      error: { message: '[via sub] slow down', type: 'rate_limit_error', param: null, code: null }
    })
    expect(bodies[2]).toEqual(bodies[1])
    expect(bodies[3]).toEqual({
      error: { code: 429, message: '[via sub] slow down', status: 'RESOURCE_EXHAUSTED' }
    })
  })
})
