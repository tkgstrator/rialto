/**
 * GET/POST /api/inbound-surfaces — per-surface routing mode.
 *
 * The read returns every surface in the registry with the mode it is
 * set to. There is no notion of a value being more default than another:
 * every surface has an explicit stored mode, seeded at boot.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { listSurfaces, updateSurface } from '../../services/inbound-surface-service'

const SurfaceIdSchema = z.enum(['anthropic-messages', 'openai-chat', 'openai-responses', 'gemini-generate'])

const SurfaceSchema = z
  .object({
    id: SurfaceIdSchema,
    path: z.string().nonempty(),
    client: z.string().nonempty(),
    inboundType: z.enum(['anthropic', 'openai', 'gemini']),
    auth: z.enum(['x-api-key', 'bearer', 'google']),
    errorShape: z.enum(['anthropic', 'openai', 'google']),
    routingMode: z.enum(['routed', 'passthrough']),
    profileKey: z.string().nonempty(),
    deniedTargets: z.array(z.string().nonempty())
  })
  .openapi('InboundSurface')

const ListResponseSchema = z.object({ surfaces: z.array(SurfaceSchema) }).openapi('InboundSurfacesResponse')

const UpdateBodySchema = z
  .object({
    surface: SurfaceIdSchema,
    routingMode: z.enum(['routed', 'passthrough']),
    profileKey: z.string().nonempty().nullable().optional(),
    // Omitted leaves the stored list alone. The mode and profile writers
    // send neither, and must not blank it by saying nothing.
    deniedTargets: z.array(z.string().nonempty()).optional()
  })
  .openapi('InboundSurfaceUpdate')

export const inboundSurfacesRoute = new OpenAPIHono()

inboundSurfacesRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/inbound-surfaces',
    responses: {
      200: {
        description: 'Every inbound surface with its effective routing mode',
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
