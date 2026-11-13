import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { SaveOutcomeSchema, TierProfileViewSchema, TierProfileWriteSchema } from '../../../../schemas/api/routing'
import { loadTierProfileView, saveTierProfile } from '../../../../services/tier-route-service'
import { validationErrorHook } from '../../../zod-response'

export const routingProfileRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

const params = z.object({ key: z.string().nonempty() })

routingProfileRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/routing/profiles/{key}',
    request: { params },
    responses: {
      200: {
        description:
          "The profile's routes per scenario and lane, each resolved through its provider's alias, and the Long context threshold in effect. A profile with no row reads as empty",
        content: { 'application/json': { schema: TierProfileViewSchema } }
      }
    }
  }),
  async (c) => c.json(await loadTierProfileView(c.req.valid('param').key), 200)
)

// Whole-profile replacement. Warnings name what was dropped (an unknown
// provider, a duplicate) or kept but unusable (an unset alias); a refusal
// — the reserved passthrough key — is a 400 with the same shape.
routingProfileRoute.openapi(
  createRoute({
    method: 'put',
    path: '/api/routing/profiles/{key}',
    request: {
      params,
      body: { content: { 'application/json': { schema: TierProfileWriteSchema } }, required: true }
    },
    responses: {
      200: { description: 'Saved', content: { 'application/json': { schema: SaveOutcomeSchema } } },
      400: { description: 'Refused', content: { 'application/json': { schema: SaveOutcomeSchema } } }
    }
  }),
  async (c) => {
    const outcome = await saveTierProfile(c.req.valid('param').key, c.req.valid('json'))
    if (!outcome.success) return c.json(outcome, 400)
    return c.json(outcome, 200)
  }
)
