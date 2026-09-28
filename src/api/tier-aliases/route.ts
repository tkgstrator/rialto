import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { TierAliasSchema } from '../../schemas/api/routing'
import { listTierAliases } from '../../services/tier-alias-service'
import { validationErrorHook } from '../zod-response'

export const tierAliasesRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

tierAliasesRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/tier-aliases',
    responses: {
      200: {
        description:
          "Every provider's four tiers — the model each reaches today, or null. A derived tier follows the newest switched-on model its name says and lists its other named models; one newer and switched off is marked new. A manual tier is the stored alias",
        content: { 'application/json': { schema: z.array(TierAliasSchema) } }
      }
    }
  }),
  async (c) => c.json(await listTierAliases(), 200)
)
