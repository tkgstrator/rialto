import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { resetLlmsContext } from '../../../../../llms'
import { RoutingErrorSchema, SetTierAliasSchema } from '../../../../../schemas/api/routing'
import { ModelTierSchema } from '../../../../../schemas/domain/tier-route'
import { syncToConfigFile } from '../../../../../services/config/sync-to-disk'
import { clearTierAlias, setTierAlias } from '../../../../../services/tier-alias-service'
import { validationErrorHook } from '../../../../zod-response'

export const providerTierAliasRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

const params = z.object({ name: z.string().nonempty(), tier: ModelTierSchema })

/**
 * Point a provider's tier at a model — the "promote" action.
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
      }
    }
  }),
  async (c) => {
    const { name, tier } = c.req.valid('param')
    const outcome = await setTierAlias(name, tier, c.req.valid('json').model)
    if (!outcome.ok) {
      const what = outcome.reason === 'provider-not-found' ? `provider "${name}"` : `model on "${name}"`
      return c.json({ error: `No such ${what}` }, 404)
    }
    if (outcome.enabledModel) {
      await syncToConfigFile()
      resetLlmsContext()
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
      204: { description: 'Unset. Routes naming this tier are skipped until one is set again' },
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
