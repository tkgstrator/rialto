import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { resetLlmsContext } from '../../../../../llms'
import { RoutingErrorSchema, SetTierAliasSchema } from '../../../../../schemas/api/routing'
import { ModelTierSchema } from '../../../../../schemas/domain/tier-route'
import { syncToConfigFile } from '../../../../../services/config/sync-to-disk'
import { republishRoutingSnapshot } from '../../../../../services/routing-scheduler'
import { clearTierAlias, setTierAlias } from '../../../../../services/tier-alias-service'
import { validationErrorHook } from '../../../../zod-response'

export const providerTierAliasRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

const params = z.object({ name: z.string().nonempty(), tier: ModelTierSchema })

/**
 * Point a provider's manual tier at a model — the "promote" action.
 *
 * Only a tier no model names takes an alias; a derived tier follows the
 * newest switched-on model its name says, so it is refused with 409 and
 * the operator switches models instead.
 *
 * The model is switched on with it, and a model that was off changes what
 * the provider serves: the Providers mirror on disk is rewritten and the
 * provider registry rebuilt, as for any other enable, so the next request
 * already reaches the model the alias names.
 */
providerTierAliasRoute.openapi(
  createRoute({
    method: 'put',
    path: '/api/providers/{name}/tier-aliases/{tier}',
    request: {
      params,
      body: { content: { 'application/json': { schema: SetTierAliasSchema } }, required: true }
    },
    responses: {
      200: {
        description: 'The alias now names this model, and the model is switched on',
        content: { 'application/json': { schema: z.object({ enabledModel: z.boolean() }) } }
      },
      404: {
        description: 'No such provider, or no such model on it',
        content: { 'application/json': { schema: RoutingErrorSchema } }
      },
      409: {
        description: 'Some model on the provider names this tier, so it follows the switches, not an alias',
        content: { 'application/json': { schema: RoutingErrorSchema } }
      }
    }
  }),
  async (c) => {
    const { name, tier } = c.req.valid('param')
    const outcome = await setTierAlias(name, tier, c.req.valid('json').model)
    if (!outcome.ok && outcome.reason === 'tier-derived') {
      return c.json(
        {
          error: `"${name}" · ${tier} follows the newest switched-on model named ${tier}; switch models on or off instead`
        },
        409
      )
    }
    if (!outcome.ok) {
      const what = outcome.reason === 'provider-not-found' ? `provider "${name}"` : `model on "${name}"`
      return c.json({ error: `No such ${what}` }, 404)
    }
    if (outcome.enabledModel) {
      await syncToConfigFile()
      resetLlmsContext()
      // A model switched on here is a new target for the quota snapshot.
      // Until a tick reads it, the router would treat it as having no
      // quota at all; republish so the first request after a promotion
      // is already judged on the model's accounts.
      await republishRoutingSnapshot()
    }
    return c.json({ enabledModel: outcome.enabledModel }, 200)
  }
)

providerTierAliasRoute.openapi(
  createRoute({
    method: 'delete',
    path: '/api/providers/{name}/tier-aliases/{tier}',
    request: { params },
    responses: {
      204: {
        description:
          'Unset. On a manual tier, routes naming it are skipped until one is set again; on a derived tier the row was dormant and routing does not change'
      },
      404: {
        description: 'The provider has no alias for this tier',
        content: { 'application/json': { schema: RoutingErrorSchema } }
      }
    }
  }),
  async (c) => {
    const { name, tier } = c.req.valid('param')
    if (!(await clearTierAlias(name, tier))) return c.json({ error: `"${name}" has no ${tier} alias` }, 404)
    return c.body(null, 204)
  }
)
