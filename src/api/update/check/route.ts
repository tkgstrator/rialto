import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { UpdateCheckQuerySchema, UpdateCheckResponseSchema } from '../../../schemas/api/update'
import { checkForUpdates } from '../../../services/update'
import { APP_VERSION } from '../../../version'

export const updateCheckRoute = new OpenAPIHono()

const route = createRoute({
  method: 'get',
  path: '/api/update/check',
  request: { query: UpdateCheckQuerySchema },
  responses: {
    200: {
      description:
        "Compares the running version against this repository's latest GitHub release. Answers 200 with status:'error' when the feed could not be read, so the UI can tell 'up to date' apart from 'could not check'.",
      content: { 'application/json': { schema: UpdateCheckResponseSchema } }
    }
  }
})
updateCheckRoute.openapi(route, async (c) => {
  const { force } = c.req.valid('query')
  const result = await checkForUpdates(APP_VERSION, force === 'true')
  return c.json(result, 200)
})
