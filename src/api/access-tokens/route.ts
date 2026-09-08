/**
 * Access token management (Phase 3.5).
 *
 * A plaintext appears in exactly two responses — the issue call and the
 * rotate call — and is not recoverable afterwards. That is the point: a
 * database read, a backup, or a later GET cannot produce a working
 * credential. Rotate is the same one-shot reveal as issue, against a row
 * that already exists.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  deleteAccessToken,
  getAccessToken,
  issueAccessToken,
  listAccessTokens,
  revokeAccessToken,
  rotateAccessToken
} from '../../services/access-token-service'

const TokenSchema = z
  .object({
    id: z.string().nonempty(),
    name: z.string().nonempty(),
    // First characters only — enough to tell two tokens apart in a list,
    // not enough to authenticate with.
    prefix: z.string().nonempty(),
    // Surfaces this token may call. Empty means every surface — the
    // meaning the nullable single-surface field carried before it
    // became a list.
    surfaces: z.array(z.string().nonempty()),
    profileKey: z.string().nonempty().nullable(),
    lastUsedAt: z.string().nonempty().nullable(),
    requestCount: z.number().int().nonnegative(),
    // Spend over the service's trailing window (SPEND_WINDOW_DAYS), not
    // over the token's life — see the service. Null when none of this
    // token's traffic could be priced.
    costUsd: z.number().nullable(),
    expiresAt: z.string().nonempty().nullable(),
    revokedAt: z.string().nonempty().nullable(),
    // Null while the row still carries the secret it was issued with.
    rotatedAt: z.string().nonempty().nullable(),
    createdAt: z.string().nonempty()
  })
  .openapi('AccessToken')

const ListSchema = z.object({ tokens: z.array(TokenSchema) }).openapi('AccessTokenList')

const IssueBodySchema = z
  .object({
    name: z.string().nonempty(),
    surfaces: z.array(z.enum(['anthropic-messages', 'openai-chat', 'openai-responses', 'gemini-generate'])).optional(),
    profileKey: z.string().nonempty().nullable().optional(),
    expiresAt: z.iso.datetime().nullable().optional()
  })
  .openapi('AccessTokenIssueRequest')

const IssuedSchema = z
  .object({
    token: TokenSchema,
    // Shown once. Reissue is the only way back if it is lost.
    plaintext: z.string().nonempty()
  })
  .openapi('AccessTokenIssued')

export const accessTokensRoute = new OpenAPIHono()

accessTokensRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/access-tokens',
    responses: {
      200: { description: 'Issued tokens', content: { 'application/json': { schema: ListSchema } } }
    }
  }),
  async (c) => c.json({ tokens: await listAccessTokens() }, 200)
)

accessTokensRoute.openapi(
  createRoute({
    method: 'post',
    path: '/api/access-tokens',
    request: { body: { content: { 'application/json': { schema: IssueBodySchema } } } },
    responses: {
      200: {
        description: 'The new token. The plaintext is returned here and never again.',
        content: { 'application/json': { schema: IssuedSchema } }
      }
    }
  }),
  async (c) => c.json(await issueAccessToken(c.req.valid('json')), 200)
)

accessTokensRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/access-tokens/{id}',
    request: { params: z.object({ id: z.string().nonempty() }) },
    responses: {
      200: { description: 'One token', content: { 'application/json': { schema: TokenSchema } } },
      404: { description: 'No such token' }
    }
  }),
  async (c) => {
    const row = await getAccessToken(c.req.valid('param').id)
    if (row === null) return c.json({ error: 'Not found' } as never, 404)
    return c.json(row, 200)
  }
)

/**
 * Rotate: a new secret on the same row.
 *
 * 409 rather than 200-with-a-dead-token when the row cannot authenticate
 * anyway — handing back a plaintext for a revoked or expired token would
 * look like success and fail at the first request.
 */
accessTokensRoute.openapi(
  createRoute({
    method: 'post',
    path: '/api/access-tokens/{id}/rotate',
    request: { params: z.object({ id: z.string().nonempty() }) },
    responses: {
      200: {
        description: 'The replacement secret. Returned here and never again; the previous one stops working now.',
        content: { 'application/json': { schema: IssuedSchema } }
      },
      404: { description: 'No such token' },
      409: { description: 'Revoked or expired — issue a new token instead of rotating this one' }
    }
  }),
  async (c) => {
    const result = await rotateAccessToken(c.req.valid('param').id)
    if (result.ok) return c.json(result.issued, 200)
    if (result.reason === 'not-found') return c.json({ error: 'Not found' } as never, 404)
    return c.json({ error: result.reason } as never, 409)
  }
)

accessTokensRoute.openapi(
  createRoute({
    method: 'post',
    path: '/api/access-tokens/{id}/revoke',
    request: { params: z.object({ id: z.string().nonempty() }) },
    responses: {
      200: { description: 'Token revoked', content: { 'application/json': { schema: TokenSchema } } },
      404: { description: 'No such token' }
    }
  }),
  async (c) => {
    const row = await revokeAccessToken(c.req.valid('param').id)
    if (row === null) return c.json({ error: 'Not found' } as never, 404)
    return c.json(row, 200)
  }
)

accessTokensRoute.openapi(
  createRoute({
    method: 'delete',
    path: '/api/access-tokens/{id}',
    request: { params: z.object({ id: z.string().nonempty() }) },
    responses: {
      200: {
        description: 'Token deleted. Prefer revoke — deleting loses the attribution on past requests.',
        content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } }
      }
    }
  }),
  async (c) => c.json({ deleted: await deleteAccessToken(c.req.valid('param').id) }, 200)
)
