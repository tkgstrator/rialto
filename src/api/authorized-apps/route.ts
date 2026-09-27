/**
 * Authorized apps — apps whose installs may register themselves with App
 * Attest — and each app's installs. Admin-only (/api/*).
 *
 * There is no delete: turning an app off stops every token it issued and
 * keeps them attributable, and turning it on again brings them back.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { createApp, getApp, listApps, listDevices, updateApp } from '../../services/authorized-app-service'
import { validationErrorHook } from '../zod-response'

const RefSchema = z.object({ id: z.string().nonempty(), name: z.string().nonempty() })

const AppSchema = z
  .object({
    id: z.string().nonempty(),
    name: z.string().nonempty(),
    // `<Team ID>.<bundle id>`.
    appleAppId: z.string().nonempty(),
    allowDevelopment: z.boolean(),
    enabled: z.boolean(),
    // The plan a new install's token is put on.
    plan: RefSchema,
    deviceCount: z.number().int().nonnegative(),
    activeDevices: z.number().int().nonnegative(),
    requestsToday: z.number().int().nonnegative(),
    costUsd: z.number().nullable(),
    createdAt: z.string().nonempty(),
    updatedAt: z.string().nonempty()
  })
  .openapi('AuthorizedApp')

const CreateBodySchema = z
  .object({
    name: z.string().nonempty(),
    appleAppId: z.string().nonempty(),
    planId: z.string().nonempty(),
    allowDevelopment: z.boolean()
  })
  .openapi('AuthorizedAppCreateRequest')

// The app page's form, saved whole. Turning the app on or off is not part
// of it: that stops or restores every token the app issued, so it is its
// own action (/enable, /disable) rather than a field a save could flip.
const UpdateBodySchema = z
  .object({
    name: z.string().nonempty(),
    planId: z.string().nonempty(),
    allowDevelopment: z.boolean()
  })
  .openapi('AuthorizedAppUpdateRequest')

const DeviceSchema = z
  .object({
    tokenId: z.string().nonempty(),
    keyPrefix: z.string().nonempty(),
    environment: z.string().nonempty(),
    plan: RefSchema.nullable(),
    requestsToday: z.number().int().nonnegative(),
    dailyRequestLimit: z.number().int().positive().nullable(),
    costUsd: z.number().nullable(),
    lastUsedAt: z.string().nonempty().nullable(),
    registeredAt: z.string().nonempty(),
    revokedAt: z.string().nonempty().nullable()
  })
  .openapi('AppDevice')

const ErrorSchema = z.object({ error: z.string().nonempty(), message: z.string().nonempty() })

const IdParams = z.object({ id: z.string().nonempty() })

export const authorizedAppsRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

authorizedAppsRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/authorized-apps',
    responses: {
      200: {
        description: 'Every authorized app, with its install counts and spend',
        content: { 'application/json': { schema: z.object({ apps: z.array(AppSchema) }) } }
      }
    }
  }),
  async (c) => c.json({ apps: await listApps() }, 200)
)

authorizedAppsRoute.openapi(
  createRoute({
    method: 'post',
    path: '/api/authorized-apps',
    request: { body: { content: { 'application/json': { schema: CreateBodySchema } } } },
    responses: {
      200: { description: 'The new app', content: { 'application/json': { schema: AppSchema } } },
      400: { description: 'Not a valid app', content: { 'application/json': { schema: ErrorSchema } } },
      409: {
        description: 'That App ID is already authorized',
        content: { 'application/json': { schema: ErrorSchema } }
      }
    }
  }),
  async (c) => {
    const result = await createApp(c.req.valid('json'))
    if (result.ok) return c.json(result.app, 200)
    if (result.reason === 'duplicate') return c.json({ error: result.reason, message: result.message }, 409)
    return c.json({ error: result.reason, message: result.message }, 400)
  }
)

authorizedAppsRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/authorized-apps/{id}',
    request: { params: IdParams },
    responses: {
      200: { description: 'One app', content: { 'application/json': { schema: AppSchema } } },
      404: { description: 'No such app', content: { 'application/json': { schema: ErrorSchema } } }
    }
  }),
  async (c) => {
    const app = await getApp(c.req.valid('param').id)
    if (app === null) return c.json({ error: 'not-found', message: 'No such app.' }, 404)
    return c.json(app, 200)
  }
)

authorizedAppsRoute.openapi(
  createRoute({
    method: 'patch',
    path: '/api/authorized-apps/{id}',
    request: { params: IdParams, body: { content: { 'application/json': { schema: UpdateBodySchema } } } },
    responses: {
      200: { description: 'The updated app', content: { 'application/json': { schema: AppSchema } } },
      400: { description: 'Not a valid change', content: { 'application/json': { schema: ErrorSchema } } },
      404: { description: 'No such app', content: { 'application/json': { schema: ErrorSchema } } }
    }
  }),
  async (c) => {
    const result = await updateApp(c.req.valid('param').id, c.req.valid('json'))
    if (result.ok) return c.json(result.app, 200)
    if (result.reason === 'not-found') return c.json({ error: result.reason, message: result.message }, 404)
    return c.json({ error: result.reason, message: result.message }, 400)
  }
)

authorizedAppsRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/authorized-apps/{id}/devices',
    request: {
      params: IdParams,
      query: z.object({
        q: z.string().nonempty().optional(),
        offset: z.coerce.number().int().nonnegative().optional(),
        limit: z.coerce.number().int().positive().optional()
      })
    },
    responses: {
      200: {
        description: 'One page of the app’s installs, most recently used first',
        content: {
          'application/json': {
            schema: z.object({ total: z.number().int().nonnegative(), devices: z.array(DeviceSchema) })
          }
        }
      }
    }
  }),
  async (c) => {
    const { q, offset, limit } = c.req.valid('query')
    return c.json(await listDevices(c.req.valid('param').id, { query: q, offset, limit }), 200)
  }
)

for (const [action, enabled] of [
  ['enable', true],
  ['disable', false]
] as const) {
  authorizedAppsRoute.openapi(
    createRoute({
      method: 'post',
      path: `/api/authorized-apps/{id}/${action}`,
      request: { params: IdParams },
      responses: {
        200: {
          description: enabled
            ? 'App on: installs may register, and the tokens it issued work again'
            : 'App off: no new installs, and every token it issued stops',
          content: { 'application/json': { schema: AppSchema } }
        },
        404: { description: 'No such app', content: { 'application/json': { schema: ErrorSchema } } }
      }
    }),
    async (c) => {
      const result = await updateApp(c.req.valid('param').id, { enabled })
      if (result.ok) return c.json(result.app, 200)
      return c.json({ error: result.reason, message: result.message }, 404)
    }
  )
}
