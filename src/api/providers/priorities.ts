import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { listProviderPriorityGroups, saveProviderPriorityGroup } from '../../services/provider-priority'
import { PROVIDER_PRIORITY_GROUPS } from '../../shared/provider-priority'
import { validationErrorHook } from '../zod-response'

const group = z.enum(PROVIDER_PRIORITY_GROUPS)
const groupsResponse = z.object({
  groups: z.array(
    z.object({
      group,
      providers: z.array(
        z.object({
          name: z.string().nonempty(),
          organizationId: z.string().nonempty().nullable(),
          displayName: z.string().nonempty().nullable()
        })
      )
    })
  )
})
export type ProviderPriorityGroupsResponse = z.infer<typeof groupsResponse>
export const providerPrioritiesRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

providerPrioritiesRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/providers/priorities',
    responses: {
      200: { description: 'Provider order by vendor', content: { 'application/json': { schema: groupsResponse } } }
    }
  }),
  async (c) => c.json({ groups: await listProviderPriorityGroups() }, 200)
)

providerPrioritiesRoute.openapi(
  createRoute({
    method: 'put',
    path: '/api/providers/priorities',
    request: {
      body: {
        content: { 'application/json': { schema: z.object({ group, providers: z.array(z.string().nonempty()) }) } },
        required: true
      }
    },
    responses: {
      200: {
        description: 'Order saved',
        content: { 'application/json': { schema: z.object({ success: z.literal(true) }) } }
      },
      409: {
        description: 'Eligible providers changed',
        content: { 'application/json': { schema: z.object({ error: z.string().nonempty() }) } }
      }
    }
  }),
  async (c) => {
    const { group, providers } = c.req.valid('json')
    if (!(await saveProviderPriorityGroup(group, providers))) {
      return c.json({ error: 'The eligible providers have changed. Refresh and try again.' }, 409)
    }
    return c.json({ success: true as const }, 200)
  }
)
