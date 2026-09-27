import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { UpdatePerformResponseSchema } from '../../../schemas/api/update'
import { performUpdate } from '../../../services/update'
import { validationErrorHook } from '../../zod-response'

export const updatePerformRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

const route = createRoute({
  method: 'post',
  path: '/api/update/perform',
  responses: {
    200: {
      description: 'Result of the self-update attempt. Always refuses: the deployment is an immutable image.',
      content: { 'application/json': { schema: UpdatePerformResponseSchema } }
    }
  }
})
updatePerformRoute.openapi(route, async (c) => {
  const result = await performUpdate()
  return c.json(result, 200)
})
