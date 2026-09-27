import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { CatalogRefreshResponseSchema, CatalogResponseSchema } from '../../schemas/api/catalog'
import { getCatalog, refreshCatalog } from '../../services/catalog-service'
import { validationErrorHook } from '../zod-response'

export const catalogRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

const listRoute = createRoute({
  method: 'get',
  path: '/api/catalog',
  responses: {
    200: {
      description: 'Provider catalog assembled from the static seed and any runtime scrape overlay',
      content: { 'application/json': { schema: CatalogResponseSchema } }
    }
  }
})
catalogRoute.openapi(listRoute, async (c) => {
  const entries = await getCatalog()
  return c.json({ entries }, 200)
})

const refreshRoute = createRoute({
  method: 'post',
  path: '/api/catalog/refresh',
  responses: {
    200: {
      description: 'Fresh catalog after re-scraping every supported vendor pricing page',
      content: { 'application/json': { schema: CatalogRefreshResponseSchema } }
    }
  }
})
catalogRoute.openapi(refreshRoute, async (c) => {
  const result = await refreshCatalog()
  return c.json(result, 200)
})
