import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  ModelProviderPrioritiesErrorSchema,
  ModelProviderPrioritiesResponseSchema,
  SetModelProviderPrioritiesSchema
} from '../../../schemas/api/model-provider-priorities'
import { listModelProviderPriorities, setModelProviderPriorities } from '../../../services/model-provider-preference'
import { validationErrorHook } from '../../zod-response'

export const modelProviderPrioritiesRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

modelProviderPrioritiesRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/models/provider-priorities',
    responses: {
      200: {
        description: 'Duplicate bare model names and the providers that serve them in global preference order',
        content: { 'application/json': { schema: ModelProviderPrioritiesResponseSchema } }
      }
    }
  }),
  async (c) => c.json({ models: await listModelProviderPriorities() }, 200)
)

modelProviderPrioritiesRoute.openapi(
  createRoute({
    method: 'put',
    path: '/api/models/provider-priorities',
    request: {
      body: { content: { 'application/json': { schema: SetModelProviderPrioritiesSchema } }, required: true }
    },
    responses: {
      200: {
        description: 'Saved the entire ordered provider preference for this bare model name',
        content: { 'application/json': { schema: z.object({ success: z.literal(true) }) } }
      },
      400: {
        description: 'The list repeats a provider',
        content: { 'application/json': { schema: ModelProviderPrioritiesErrorSchema } }
      },
      404: {
        description: 'The model name is unknown or a provider does not serve it',
        content: { 'application/json': { schema: ModelProviderPrioritiesErrorSchema } }
      }
    }
  }),
  async (c) => {
    const { model, providers } = c.req.valid('json')
    const result = await setModelProviderPriorities(model, providers)
    if (result.ok) return c.json({ success: true as const }, 200)
    if (result.reason === 'duplicate-provider')
      return c.json({ error: `Provider "${result.provider}" appears twice` }, 400)
    if (result.reason === 'model-not-found') return c.json({ error: `Model "${model}" not found` }, 404)
    return c.json({ error: `Provider "${result.provider}" does not serve model "${model}"` }, 404)
  }
)
