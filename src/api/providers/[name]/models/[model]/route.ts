import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  UpdateModelBodySchema,
  UpdateModelErrorResponseSchema,
  UpdateModelSuccessResponseSchema
} from '../../../../../schemas/api/models'
import { setModelEnabled, setModelReasoningEffort } from '../../../../../services/config'
import { ValidationErrorResponseSchema, validationErrorHook } from '../../../../zod-response'

export const providerModelRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

const ProviderModelParamsSchema = z.object({
  name: z
    .string()
    .nonempty()
    .openapi({ param: { name: 'name', in: 'path' } }),
  model: z
    .string()
    .nonempty()
    .openapi({ param: { name: 'model', in: 'path' } })
})

const updateModelRoute = createRoute({
  method: 'patch',
  path: '/api/providers/{name}/models/{model}',
  request: {
    params: ProviderModelParamsSchema,
    body: { content: { 'application/json': { schema: UpdateModelBodySchema } } }
  },
  responses: {
    200: {
      description: 'Model enable/disable toggled.',
      content: { 'application/json': { schema: UpdateModelSuccessResponseSchema } }
    },
    400: {
      description: 'Validation failure — see issues[].',
      content: { 'application/json': { schema: ValidationErrorResponseSchema } }
    },
    404: {
      description: 'Provider or model not found.',
      content: { 'application/json': { schema: UpdateModelErrorResponseSchema } }
    }
  }
})

providerModelRoute.openapi(updateModelRoute, async (c) => {
  const { name, model } = c.req.valid('param')
  const body = c.req.valid('json')
  try {
    if (body.enabled !== undefined) {
      await setModelEnabled(name, model, body.enabled)
    }
    if (body.reasoningEffort !== undefined) {
      await setModelReasoningEffort(name, model, body.reasoningEffort)
    }
    return c.json({ success: true as const }, 200)
  } catch (err) {
    return c.json({ success: false as const, error: err instanceof Error ? err.message : String(err) }, 404)
  }
})
