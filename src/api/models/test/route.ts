import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { ModelTestRequestSchema, ModelTestResultSchema } from '../../../schemas/api/models'
import { type ModelTestResult, testModel } from '../../../services/model-test-service'
import { validationErrorHook } from '../../zod-response'

export const modelTestRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

// Map a test-failure reason onto the HTTP status the endpoint returns.
// `provider not found` / `model not found on provider` → 404 (the
// caller referenced an unknown row). `no api key on file` / `model is
// disabled` → 400 (a client-side setup issue, not the vendor's fault).
// Everything else — the vendor rejected the probe, network timeout, etc.
// — is an upstream failure surfaced as 502.
const errorStatusFor = (error: string | undefined): 400 | 404 | 502 => {
  if (error === 'provider not found') return 404
  if (error === 'model not found on provider') return 404
  if (error === 'model is disabled') return 400
  if (error === 'no api key on file') return 400
  return 502
}

const route = createRoute({
  method: 'post',
  path: '/api/models/test',
  request: {
    body: {
      content: { 'application/json': { schema: ModelTestRequestSchema } },
      required: true
    }
  },
  responses: {
    200: {
      description: 'Real-inference connectivity test result for one model — vendor accepted the probe.',
      content: { 'application/json': { schema: ModelTestResultSchema } }
    },
    400: {
      description: 'Test could not run because the model is disabled or the provider has no api key.',
      content: { 'application/json': { schema: ModelTestResultSchema } }
    },
    404: {
      description: 'Provider or model not found.',
      content: { 'application/json': { schema: ModelTestResultSchema } }
    },
    502: {
      description: 'Upstream vendor rejected the probe or the request failed to reach it.',
      content: { 'application/json': { schema: ModelTestResultSchema } }
    }
  }
})
modelTestRoute.openapi(route, async (c) => {
  const { provider, model } = c.req.valid('json')
  const result: ModelTestResult = await testModel(provider, model)
  if (result.status === 'ok') return c.json(result, 200)
  return c.json(result, errorStatusFor(result.error))
})
