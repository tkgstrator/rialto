import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  ProviderDeleteResponseSchema,
  ProviderErrorResponseSchema,
  ProviderUpsertResponseSchema
} from '../../../schemas/api/providers'
import { ProviderSchema } from '../../../schemas/domain/provider'
import { deleteProviderByName, upsertProvider } from '../../../services/config'
import { ValidationErrorResponseSchema, validationErrorHook } from '../../zod-response'

export const providerByNameRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

const NameParamSchema = z.object({
  name: z
    .string()
    .nonempty()
    .openapi({ param: { name: 'name', in: 'path' } })
})

// PATCH body omits `name` — the URL path supplies it.
const ProviderPatchBodySchema = ProviderSchema.omit({ name: true })

const patchProviderRoute = createRoute({
  method: 'patch',
  path: '/api/providers/{name}',
  request: {
    params: NameParamSchema,
    body: { content: { 'application/json': { schema: ProviderPatchBodySchema } } }
  },
  responses: {
    200: {
      description: 'Provider updated. `warnings` lists non-fatal apply-layer notes.',
      content: { 'application/json': { schema: ProviderUpsertResponseSchema } }
    },
    400: {
      description: 'Validation failure — see issues[].',
      content: { 'application/json': { schema: ValidationErrorResponseSchema } }
    }
  }
})

providerByNameRoute.openapi(patchProviderRoute, async (c) => {
  const { name } = c.req.valid('param')
  const body = c.req.valid('json')
  const { provider, warnings } = await upsertProvider({ ...body, name })
  return c.json(
    {
      success: true as const,
      provider,
      ...(warnings.length > 0 ? { warnings } : {})
    },
    200
  )
})

const deleteProviderRoute = createRoute({
  method: 'delete',
  path: '/api/providers/{name}',
  request: { params: NameParamSchema },
  responses: {
    200: {
      description: 'Provider deleted.',
      content: { 'application/json': { schema: ProviderDeleteResponseSchema } }
    },
    404: {
      description: 'Provider not found.',
      content: { 'application/json': { schema: ProviderErrorResponseSchema } }
    }
  }
})

providerByNameRoute.openapi(deleteProviderRoute, async (c) => {
  const { name } = c.req.valid('param')
  try {
    const { warnings } = await deleteProviderByName(name)
    return c.json({ success: true as const, ...(warnings.length > 0 ? { warnings } : {}) }, 200)
  } catch (err) {
    return c.json({ success: false as const, error: err instanceof Error ? err.message : String(err) }, 404)
  }
})
