import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { TierAliasSchema } from '../../schemas/api/routing'
import { listTierAliases } from '../../services/tier-alias-service'

export const tierAliasesRoute = new OpenAPIHono()

tierAliasesRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/tier-aliases',
    responses: {
      200: {
        description:
          "Every provider's four tier slots — the model each names, or null — with the models that could take each; a model that appeared after the alias was set is marked new",
        content: { 'application/json': { schema: z.array(TierAliasSchema) } }
      }
    }
  }),
  async (c) => c.json(await listTierAliases(), 200)
)
