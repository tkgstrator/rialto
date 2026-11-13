import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import {
  CustomProviderCreateRequestSchema,
  CustomProviderCreateResponseSchema,
  ProviderErrorResponseSchema
} from '../../../schemas/api/providers'
import { createCustomProvider } from '../../../services/custom-provider-service'
import { republishRoutingSnapshot } from '../../../services/routing-scheduler'
import { ValidationErrorResponseSchema, validationErrorHook } from '../../zod-response'

export const customProviderRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

const createCustomRoute = createRoute({
  method: 'post',
  path: '/api/providers/custom',
  request: {
    body: { content: { 'application/json': { schema: CustomProviderCreateRequestSchema } }, required: true }
  },
  responses: {
    201: {
      description:
        'Custom provider created, switched off. `models` reports the one-shot lookup of its model list; an ' +
        'unavailable list is a normal outcome and the operator adds model ids by hand.',
      content: { 'application/json': { schema: CustomProviderCreateResponseSchema } }
    },
    400: {
      description: 'Validation failure — see issues[]. A name or Base URL problem arrives as an issue code.',
      content: { 'application/json': { schema: ValidationErrorResponseSchema } }
    },
    409: {
      description: 'A provider with this name already exists.',
      content: { 'application/json': { schema: ProviderErrorResponseSchema } }
    }
  }
})

customProviderRoute.openapi(createCustomRoute, async (c) => {
  const result = await createCustomProvider(c.req.valid('json'))
  if (!result.ok) {
    // `invalid_base_url` cannot reach here through the schema, which checks
    // the same rule; the branch is the service's own guard.
    return result.reason === 'name_taken'
      ? c.json({ success: false as const, error: 'A provider with this name already exists.' }, 409)
      : c.json({ success: false as const, error: { type: 'validation_error' as const, issues: [] } }, 400)
  }
  // The new provider has no switched-on model yet, so no tier route can have
  // moved; the snapshot is still rebuilt so the Routing screen lists it.
  await republishRoutingSnapshot()
  return c.json(
    {
      success: true as const,
      provider: result.provider,
      models: result.models,
      warnings: result.warnings
    },
    201
  )
})
