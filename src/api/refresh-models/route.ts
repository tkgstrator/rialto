import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { RefreshModelsResponseSchema } from '../../schemas/api/models'
import { refreshModelsForAllProviders } from '../../services/model-sync-service'
import { validationErrorHook } from '../zod-response'

export const refreshModelsRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

const route = createRoute({
  method: 'post',
  path: '/api/refresh-models',
  responses: {
    200: {
      description: 'Outcome per provider after the upstream model sweep',
      content: { 'application/json': { schema: RefreshModelsResponseSchema } }
    }
  }
})
refreshModelsRoute.openapi(route, async (c) => {
  const outcomes = await refreshModelsForAllProviders()
  return c.json({ outcomes }, 200)
})
