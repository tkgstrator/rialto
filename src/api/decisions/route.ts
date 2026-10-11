import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import {
  DecisionEvaluateRequestSchema,
  DecisionEvaluateResponseSchema,
  DecisionStatusResponseSchema,
  DecisionUpstreamErrorSchema
} from '../../schemas/api/decisions'
import { evaluateWithJeff, getJeffStatus } from '../../services/jeff-client'
import { ValidationErrorResponseSchema, validationErrorHook } from '../zod-response'

// Mounted beneath the root's /api/* admin gate; never register this as /v1/systemone.
export const decisionsRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

decisionsRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/decisions/status',
    responses: {
      200: {
        description: 'Availability of the server-configured Jeff instance',
        content: { 'application/json': { schema: DecisionStatusResponseSchema } }
      }
    }
  }),
  async (c) => c.json(await getJeffStatus(), 200)
)

decisionsRoute.openapi(
  createRoute({
    method: 'post',
    path: '/api/decisions/evaluate',
    request: { body: { required: true, content: { 'application/json': { schema: DecisionEvaluateRequestSchema } } } },
    responses: {
      200: {
        description: 'System One decisions from Jeff',
        content: { 'application/json': { schema: DecisionEvaluateResponseSchema } }
      },
      400: {
        description: 'Invalid request',
        content: { 'application/json': { schema: ValidationErrorResponseSchema } }
      },
      502: {
        description: 'Jeff could not evaluate the request',
        content: { 'application/json': { schema: DecisionUpstreamErrorSchema } }
      }
    }
  }),
  async (c) => {
    const result = await evaluateWithJeff(c.req.valid('json'))
    if (!result.ok) return c.json({ error: result.error }, 502)
    return c.json(result.data, 200)
  }
)
