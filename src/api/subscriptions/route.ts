import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  SubscriptionRefreshErrorSchema,
  SubscriptionRefreshRequestSchema,
  SubscriptionRefreshResponseSchema,
  SubscriptionsResponseSchema
} from '../../schemas/api/subscriptions'
import { syncSubAccountProfiles } from '../../services/subscription-account-sync-service'
import { getSubscriptionsInfo } from '../../services/subscription-info-service'
import { refreshProviderSubscriptions, refreshSubscriptions } from '../../services/subscription-refresh-service'

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

// The account half of the Providers screens' Refresh. Unlike /sync it
// also polls usage past the 5-minute cache and rewrites the quota the
// list reads. Bare, it covers every account on an enabled provider (the
// Subscriptions list); `provider` narrows it to that provider's accounts,
// switched on or not (the provider's own page). The two stay separate
// because /sync is what the auth-health job's contract looks like from
// outside, and a profile probe should not start spending usage calls.
const refreshSubscriptionsRoute = createRoute({
  method: 'post',
  path: '/api/subscriptions/refresh',
  request: {
    // Optional, so a bare POST still means every enabled provider — what
    // the endpoint meant before it took a body.
    body: { content: { 'application/json': { schema: SubscriptionRefreshRequestSchema } }, required: false }
  },
  responses: {
    200: {
      description:
        'Re-sync the accounts in scope — profile, then usage past the 5-minute cache — and rewrite the quota the Providers screens read. Without `provider`, every account on an enabled subscription provider; with it, every account on that provider, even while it is switched off',
      content: { 'application/json': { schema: SubscriptionRefreshResponseSchema } }
    },
    404: {
      description: 'No subscription provider has the name given as `provider`',
      content: { 'application/json': { schema: SubscriptionRefreshErrorSchema } }
    }
  }
})
subscriptionsRoute.openapi(refreshSubscriptionsRoute, async (c) => {
  const { provider } = c.req.valid('json')
  if (provider === undefined) return c.json(await refreshSubscriptions(), 200)
  const outcome = await refreshProviderSubscriptions(provider)
  if (outcome === null) return c.json({ error: `No subscription provider is named ${provider}` }, 404)
  return c.json(outcome, 200)
})
