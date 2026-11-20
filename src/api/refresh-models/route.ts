import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { RefreshModelsResponseSchema } from '../../schemas/api/models'
import { refreshCustomProviderModels, refreshModelsForAllProviders } from '../../services/model-sync-service'
import { validationErrorHook } from '../zod-response'

export const refreshModelsRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

const route = createRoute({
  method: 'post',
  path: '/api/refresh-models',
  request: { query: z.object({ provider: z.string().nonempty().optional() }) },
  responses: {
    200: {
      description: 'Outcome per provider after the upstream model sweep',
      content: { 'application/json': { schema: RefreshModelsResponseSchema } }
    }
  }
})
refreshModelsRoute.openapi(route, async (c) => {
  const { provider } = c.req.valid('query')
  const outcomes =
    provider === undefined ? await refreshModelsForAllProviders() : [await refreshCustomProviderModels(provider)]
  return c.json({ outcomes }, 200)
})
