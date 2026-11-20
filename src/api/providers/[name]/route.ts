import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  ProviderDeleteResponseSchema,
  ProviderErrorResponseSchema,
  ProviderUpsertResponseSchema
} from '../../../schemas/api/providers'
import { ProviderSchema } from '../../../schemas/domain/provider'
import { deleteProviderByName, updateProviderConnection, upsertProvider } from '../../../services/config'
import { republishRoutingSnapshot } from '../../../services/routing-scheduler'
import { isProviderBaseUrl } from '../../../shared/provider-base-url'
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
  // A switch changes which models the quota snapshot covers, so it is
  // rebuilt now rather than at the next tick.
  await republishRoutingSnapshot()
  return c.json(
    {
      success: true as const,
      provider,
      ...(warnings.length > 0 ? { warnings } : {})
    },
    200
  )
})

const connectionRoute = createRoute({
  method: 'patch',
  path: '/api/providers/{name}/connection',
  request: {
    params: NameParamSchema,
    body: {
      content: {
        'application/json': {
          schema: z.object({
            display_name: z.string().trim().nonempty().max(120).nullable(),
            api_base_url: z
              .string()
              .trim()
              .pipe(z.url().refine(isProviderBaseUrl, 'Use an HTTP(S) endpoint without credentials or a fragment.'))
              .optional()
          })
        }
      }
    }
  },
  responses: {
    200: {
      description: 'Connection updated.',
      content: { 'application/json': { schema: z.object({ success: z.literal(true) }) } }
    },
    400: {
      description: 'Invalid connection settings.',
      content: { 'application/json': { schema: ProviderErrorResponseSchema } }
    },
    404: {
      description: 'Provider not found.',
      content: { 'application/json': { schema: ProviderErrorResponseSchema } }
    }
  }
})

providerByNameRoute.openapi(connectionRoute, async (c) => {
  const { name } = c.req.valid('param')
  const body = c.req.valid('json')
  const result = await updateProviderConnection(name, { displayName: body.display_name, apiBaseUrl: body.api_base_url })
  if (result === 'missing') return c.json({ success: false as const, error: 'Provider not found.' }, 404)
  if (result === 'subscription') {
    return c.json({ success: false as const, error: 'Subscription endpoints are managed by the provider.' }, 400)
  }
  await republishRoutingSnapshot()
  return c.json({ success: true as const }, 200)
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
    await deleteProviderByName(name)
    await republishRoutingSnapshot()
    return c.json({ success: true as const }, 200)
  } catch (err) {
    return c.json({ success: false as const, error: err instanceof Error ? err.message : String(err) }, 404)
  }
})
