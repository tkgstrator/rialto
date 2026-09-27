/**
 * GET /v1/models — OpenAI-compat catalog surface.
 *
 * OpenAI SDK / Cline / OpenWebUI probe this on init to build the model
 * dropdown; without it the SDK errors before making any inference call.
 * We serve the same DB-backed enabled-model list `/api/models` returns,
 * reshaped into OpenAI's `{object:'list', data:[{id, object, created,
 * owned_by}]}` envelope. `id` is Rialto's canonical "provider,model" form
 * so a client can round-trip the string straight into
 * /v1/chat/completions' `model` field.
 *
 * The list only includes models the router can actually reach right now
 * (auth resolved + provider enabled), mirroring what the Router selects
 * see — so a listed id is guaranteed routable at that moment.
 */

import { Hono } from 'hono'
import { getEnabledModels } from '../../services/config'

export const v1ModelsRoute = new Hono()

v1ModelsRoute.get('/v1/models', async (c) => {
  const [chatModels, imageModels] = await Promise.all([getEnabledModels(), getEnabledModels(undefined, 'image')])
  const models = [...chatModels, ...imageModels]
  // OpenAI uses seconds-since-epoch for `created`; the value carries no
  // real meaning here (there is no per-model creation time in Rialto), so
  // stamp the response time uniformly. SDKs that render "last modified"
  // will see all models as freshly listed.
  const now = Math.floor(Date.now() / 1000)
  return c.json({
    object: 'list',
    data: models.map((m) => ({
      id: `${m.provider},${m.model}`,
      object: 'model',
      created: now,
      owned_by: m.provider
    }))
  })
})
