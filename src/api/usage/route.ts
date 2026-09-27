import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { UsageResponseSchema } from '../../schemas/api/usage'
import { fetchUsageSnapshot } from '../../services/usage-service'
import { validationErrorHook } from '../zod-response'

export const usageRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

const getUsageRoute = createRoute({
  method: 'get',
  path: '/api/usage',
  responses: {
    200: {
      description:
        'Subscription usage: Claude from its official OAuth usage endpoint (live), Codex from the latest snapshot captured off real /v1 traffic.',
      content: { 'application/json': { schema: UsageResponseSchema } }
    }
  }
})

usageRoute.openapi(getUsageRoute, async (c) => {
  const { usage } = await fetchUsageSnapshot()
  // Run the response through the schema so cached ClaudeUsage entries
  // that predate the `weeklyScoped` field (still resident in the in-memory
  // cache after a code reload) pick up its default `[]`, instead of the
  // frontend seeing `undefined` and crashing on `.map`.
  return c.json(UsageResponseSchema.parse(usage), 200)
})
