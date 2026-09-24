import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { TierProfileSummarySchema } from '../../../schemas/api/routing'
import { listTierProfiles } from '../../../services/tier-route-service'

export const routingProfilesRoute = new OpenAPIHono()

// Every profile a surface or an access token can point at: the default
// even before it has a row, and the reserved passthrough key, flagged.
routingProfilesRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/routing/profiles',
    responses: {
      200: {
        description: 'Tier-map profiles, the default first and the reserved passthrough key last',
        content: { 'application/json': { schema: z.array(TierProfileSummarySchema) } }
      }
    }
  }),
  async (c) => c.json(await listTierProfiles(), 200)
)
