/**
 * The recursive JSON value schema.
 *
 * Free-form JSON values use `JsonValueSchema` instead of `z.any()` /
 * `z.unknown()` so every value still has a real, validatable type. It
 * backs the catchall on the disk envelope and the /api/config payload,
 * and types the envelope's `StatusLine`.
 *
 * The preset manifest schemas that used to share this file went with the
 * preset installer they described; nothing parsed a manifest.
 */

import { z } from '@hono/zod-openapi'

// Empty strings are legal JSON string values — an envelope key set to
// "" is a legitimate config, not a schema violation. Object KEYS keep
// the nonempty guard below (record keys) so we still reject `{"": ...}`
// entries that could shadow real keys.
export const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
export type JsonPrimitive = z.infer<typeof JsonPrimitiveSchema>

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(z.string().nonempty(), JsonValueSchema)])
)

export const JsonObjectSchema = z.record(z.string().nonempty(), JsonValueSchema)
export type JsonObject = z.infer<typeof JsonObjectSchema>
