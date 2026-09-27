/**
 * Shared OpenAPIHono instance for the request-log route group. Kept in
 * its own module so the per-concern route files (sessions /
 * session-detail / logs-crud / sse) can register directly onto it at
 * module scope without a circular import on route.ts.
 */

import { OpenAPIHono } from '@hono/zod-openapi'
import { validationErrorHook } from '../zod-response'

export const requestLogsRoute = new OpenAPIHono({ defaultHook: validationErrorHook })
