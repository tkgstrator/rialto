import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { SubscriptionRefreshResponseSchema, SubscriptionsResponseSchema } from '../../schemas/api/subscriptions'
import { syncSubAccountProfiles } from '../../services/subscription-account-sync-service'
import { getSubscriptionsInfo } from '../../services/subscription-info-service'
import { refreshSubscriptions } from '../../services/subscription-refresh-service'

export const subscriptionsRoute = new OpenAPIHono()

const getSubscriptionsRoute = createRoute({
  method: 'get',
  path: '/api/subscriptions',
  responses: {
    200: {
      description: 'Subscription credentials info per provider',
      content: { 'application/json': { schema: SubscriptionsResponseSchema } }
    }
  }
})
subscriptionsRoute.openapi(getSubscriptionsRoute, async (c) => {
  const subscriptions = await getSubscriptionsInfo()
  return c.json({ subscriptions }, 200)
})

const syncSubscriptionsRoute = createRoute({
  method: 'post',
  path: '/api/subscriptions/sync',
  responses: {
    200: {
      description: 'Re-fetch profile data from upstream and return refreshed subscriptions',
      content: {
        'application/json': {
          schema: z.object({ updated: z.number(), failed: z.number() }).merge(SubscriptionsResponseSchema)
        }
      }
    }
  }
})
subscriptionsRoute.openapi(syncSubscriptionsRoute, async (c) => {
  const { updated, failed } = await syncSubAccountProfiles()
  const subscriptions = await getSubscriptionsInfo()
  return c.json({ updated, failed, subscriptions }, 200)
})

// The Subscriptions list's Refresh button. Unlike /sync it also polls
// usage past the 5-minute cache and rewrites the quota the list reads,
// and it skips accounts on disabled providers. The two stay separate
// because /sync is what the auth-health job's contract looks like from
// outside, and a profile probe should not start spending usage calls.
const refreshSubscriptionsRoute = createRoute({
  method: 'post',
  path: '/api/subscriptions/refresh',
  responses: {
    200: {
      description:
        'Re-sync every account on an enabled subscription provider — profile, then usage past the 5-minute cache — and rewrite the quota the Providers list reads',
      content: { 'application/json': { schema: SubscriptionRefreshResponseSchema } }
    }
  }
})
subscriptionsRoute.openapi(refreshSubscriptionsRoute, async (c) => c.json(await refreshSubscriptions(), 200))
