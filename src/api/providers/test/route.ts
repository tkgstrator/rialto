import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { ProviderTestRequestSchema, ProviderTestResponseSchema, ValidationErrorSchema } from '../../../schemas/api'
import { testProvider } from '../../../services/provider-test-service'
import { validationErrorHook } from '../../zod-response'

export const providersTestRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

const route = createRoute({
  method: 'post',
  path: '/api/providers/test',
  request: {
    body: {
      content: { 'application/json': { schema: ProviderTestRequestSchema } },
      required: true
    }
  },
  responses: {
    200: {
      description: 'Provider connection probe result',
      content: { 'application/json': { schema: ProviderTestResponseSchema } }
    },
    400: {
      description: 'Provider name missing or invalid',
      content: { 'application/json': { schema: ValidationErrorSchema } }
    }
  }
})
providersTestRoute.openapi(route, async (c) => {
  const { name } = c.req.valid('json')
  const trimmed = name.trim()
  if (!trimmed) {
    return c.json({ success: false as const, error: 'name is required' }, 400)
  }
  const result = await testProvider(trimmed)
  return c.json(result, 200)
})
