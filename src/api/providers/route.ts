import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { VENDOR_DEFAULTS } from '@/shared/data'
import { ProviderListResponseSchema, ProviderUpsertResponseSchema } from '../../schemas/api/providers'
import { ProviderSchema } from '../../schemas/domain/provider'
import { discoverAnthropicApiKeyModels } from '../../services/anthropic-api-key-models'
import { getProviders, upsertProvider } from '../../services/config'
import { republishRoutingSnapshot } from '../../services/routing-scheduler'
import { ValidationErrorResponseSchema, validationErrorHook } from '../zod-response'

export const providersRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

const listProvidersRoute = createRoute({
  method: 'get',
  path: '/api/providers',
  responses: {
    200: {
      description: 'List every provider row.',
      content: { 'application/json': { schema: ProviderListResponseSchema } }
    }
  }
})

providersRoute.openapi(listProvidersRoute, async (c) => {
  const providers = await getProviders()
  return c.json(providers, 200)
})

const createProviderRoute = createRoute({
  method: 'post',
  path: '/api/providers',
  request: {
    body: { content: { 'application/json': { schema: ProviderSchema } } }
  },
  responses: {
    201: {
      description: 'Provider created. `warnings` lists non-fatal apply-layer notes.',
      content: { 'application/json': { schema: ProviderUpsertResponseSchema } }
    },
    400: {
      description: 'Validation failure — see issues[].',
      content: { 'application/json': { schema: ValidationErrorResponseSchema } }
    }
  }
})

providersRoute.openapi(createProviderRoute, async (c) => {
  const data = c.req.valid('json')
  const { provider, warnings } = await upsertProvider(data)
  // A switch changes which models the quota snapshot covers, so it is
  // rebuilt now rather than at the next tick.
  await republishRoutingSnapshot()
  return c.json(
    {
      success: true as const,
      provider,
      ...(warnings.length > 0 ? { warnings } : {})
    },
    201
  )
})

const addApiKeyRoute = createRoute({
  method: 'post',
  path: '/api/providers/api-keys',
  request: {
    body: {
      content: {
        'application/json': {
          schema: ProviderSchema.refine(
            (data) =>
              Object.hasOwn(VENDOR_DEFAULTS, data.name) && data.auth_mode === 'api_key' && !!data.api_key?.trim(),
            'A catalog vendor and API key are required'
          )
        }
      },
      required: true
    }
  },
  responses: createProviderRoute.responses
})

providersRoute.openapi(addApiKeyRoute, async (c) => {
  const data = c.req.valid('json')
  const discovered = data.name === 'anthropic' ? await discoverAnthropicApiKeyModels(data) : { provider: data }
  const { provider, warnings } = await upsertProvider(discovered.provider, true)
  if (discovered.warning !== undefined) warnings.push(discovered.warning)
  await republishRoutingSnapshot()
  return c.json({ success: true as const, provider, ...(warnings.length > 0 ? { warnings } : {}) }, 201)
})
