/**
 * GET/POST /api/inbound-surfaces — per-surface denied targets.
 *
 * The read returns every surface in the registry with the targets turned
 * off for it. A surface with nothing turned off serves anything the
 * providers serve.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { listSurfaces, updateSurface } from '../../services/inbound-surface-service'
import { validationErrorHook } from '../zod-response'

const SurfaceIdSchema = z.enum([
  'anthropic-messages',
  'openai-chat',
  'openai-responses',
  'gemini-generate',
  'openai-images'
])

const SurfaceSchema = z
  .object({
    id: SurfaceIdSchema,
    path: z.string().nonempty(),
    client: z.string().nonempty(),
    inboundType: z.enum(['anthropic', 'openai', 'gemini']),
    operation: z.enum(['completion', 'image']),
    auth: z.enum(['x-api-key', 'bearer', 'google']),
    errorShape: z.enum(['anthropic', 'openai', 'google']),
    deniedTargets: z.array(z.string().nonempty())
  })
  .openapi('InboundSurface')

const ListResponseSchema = z.object({ surfaces: z.array(SurfaceSchema) }).openapi('InboundSurfacesResponse')

const UpdateBodySchema = z
  .object({
    surface: SurfaceIdSchema,
    // Replaces the stored list wholesale.
    deniedTargets: z.array(z.string().nonempty())
  })
  .openapi('InboundSurfaceUpdate')

export const inboundSurfacesRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

inboundSurfacesRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/inbound-surfaces',
    responses: {
      200: {
        description: 'Every inbound surface with the targets turned off for it',
        content: { 'application/json': { schema: ListResponseSchema } }
      }
    }
  }),
  async (c) => c.json({ surfaces: await listSurfaces() }, 200)
)

inboundSurfacesRoute.openapi(
  createRoute({
    method: 'post',
    path: '/api/inbound-surfaces',
    request: { body: { content: { 'application/json': { schema: UpdateBodySchema } } } },
    responses: {
      200: {
        description: 'Surface updated; returns the full refreshed list',
        content: { 'application/json': { schema: ListResponseSchema } }
      }
    }
  }),
  async (c) => {
    const body = c.req.valid('json')
    return c.json({ surfaces: await updateSurface(body) }, 200)
  }
)
