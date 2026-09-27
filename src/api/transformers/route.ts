import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { getLlmsContext } from '../../llms'
import { TransformersResponseSchema } from '../../schemas/api/transformers'
import { validationErrorHook } from '../zod-response'
export const transformersRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

const getTransformersRoute = createRoute({
  method: 'get',
  path: '/api/transformers',
  responses: {
    200: {
      description: 'Built-in transformers registered on the server',
      content: { 'application/json': { schema: TransformersResponseSchema } }
    }
  }
})

transformersRoute.openapi(getTransformersRoute, async (c) => {
  const ctx = await getLlmsContext()
  const transformers = ctx.transformers.getAll().map((t) => ({ name: t.name, endpoint: t.endPoint ?? null }))
  return c.json({ transformers }, 200)
})
