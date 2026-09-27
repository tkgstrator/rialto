import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { ModelTestAllRequestSchema, ModelTestAllResponseSchema } from '../../../schemas/api/models'
import { testAllModels } from '../../../services/model-test-service'
import { validationErrorHook } from '../../zod-response'

export const modelTestAllRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

const route = createRoute({
  method: 'post',
  path: '/api/models/test-all',
  request: {
    body: {
      content: { 'application/json': { schema: ModelTestAllRequestSchema } },
      required: true
    }
  },
  responses: {
    200: {
      description: 'Batch real-inference test (scope: all | failing)',
      content: { 'application/json': { schema: ModelTestAllResponseSchema } }
    }
  }
})
modelTestAllRoute.openapi(route, async (c) => {
  const { scope } = c.req.valid('json')
  const outcome = await testAllModels(scope)
  return c.json(outcome, 200)
})
