/**
 * `validationErrorHook` wires the ZodError shape into createRoute-based
 * sub-apps: pass it as `defaultHook` on `new OpenAPIHono({...})` so
 * request validation failures from the @hono/zod-openapi middleware
 * surface in the same envelope as app.onError ZodError handling.
 *
 * `ValidationErrorResponseSchema` is the wire shape — exported so
 * createRoute responses can declare it as the 400 shape (keeps OpenAPI
 * docs in sync with the actual response).
 */

import { z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import type { ZodError } from 'zod'

export const ValidationErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.object({
      type: z.literal('validation_error'),
      issues: z.array(z.unknown())
    })
  })
  .openapi('ValidationErrorResponse')

type HookResult = { success: true } | { success: false; error: ZodError }

// Annotated: inferred, the return type names hono's unexported
// JSONRespondReturn, which a declaration cannot reference (TS2883).
export const validationErrorHook = (result: HookResult, c: Context): Response | undefined => {
  if (!result.success)
    return c.json(
      { success: false as const, error: { type: 'validation_error' as const, issues: result.error.issues } },
      400
    )
}
