import { OpenAPIHono } from '@hono/zod-openapi'
import { resetLlmsContext } from '../../llms'
import { ApplyConfigPayloadSchema } from '../../schemas/api/config'
import { applyUiConfig, composeUiConfig } from '../../services/config'
import { republishRoutingSnapshot } from '../../services/routing-scheduler'
import { validationErrorHook } from '../zod-response'
export const configRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

// Neither /api/config route is registered through createRoute: the
// LegacyConfig the server returns (and the ApplyConfigPayload it
// accepts) carry a recursive JsonValue subtree (the envelope's
// catchall). Feeding that to @hono/zod-openapi blows the
// stack during OpenAPI doc generation (zod-to-openapi recurses the
// self-referential schema). We still validate the POST body with the
// same zod schema by hand. The schemas stay exported for typing/docs.
configRoute.get('/api/config', async (c) => {
  const config = await composeUiConfig()
  return c.json(config)
})

configRoute.post('/api/config', async (c) => {
  const raw = await c.req.json().catch(() => null)
  const parsed = ApplyConfigPayloadSchema.parse(raw)
  const result = await applyUiConfig(parsed)
  // The /v1 proxy caches the llms services (providers, persona) built
  // from this config — drop it so edits take effect without a restart.
  resetLlmsContext()
  // A switch can move a tier route (it follows the newest switched-on
  // model), so the quota snapshot is rebuilt now rather than at the next tick.
  await republishRoutingSnapshot()
  return c.json({
    success: true,
    message: 'Config saved successfully',
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {})
  })
})
