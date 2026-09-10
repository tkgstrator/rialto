/**
 * The /api/config request and response shapes.
 *
 * All three are the disk envelope (domain/config.ts) widened with the
 * DB-resident Providers, and they differ only in how strict they are
 * about the scalars — which is exactly the kind of difference that
 * belongs in the api layer rather than in the domain one.
 */

import { z } from '@hono/zod-openapi'
import { ConfigEnvelopeSchema, PersonaSchema } from '@/schemas/domain/config'
import { JsonValueSchema } from '@/schemas/domain/preset'
import { ProviderSchema } from '@/schemas/domain/provider'
import { StatusLineConfigSchema } from '@/schemas/domain/status-line'
import { EmptyStringToNullSchema } from '@/schemas/primitives/common'

// API wire shape returned by /api/config and emitted by composeUiConfig
// / loadFullConfig. Extends ConfigEnvelopeSchema with the DB-resident
// Providers and overrides the optional scalars so "unset" travels as
// null (composeUiConfig emits null when absent / '' on disk).
// Registered as .openapi('Config') for the generated OpenAPI document.
export const AppConfigSchema = ConfigEnvelopeSchema.extend({
  Providers: z.array(ProviderSchema),
  PROXY_URL: z.string().nullable(),
  CLAUDE_PATH: z.string().nullable(),
  // The active persona's id, null when none is active.
  ActivePersona: z.string().nullable(),
  // The persona library is always a plain array (default []).
  Personas: z.array(PersonaSchema).default([])
}).openapi('Config')
export type AppConfig = z.infer<typeof AppConfigSchema>

// UI-side config shape consumed by components. Differs from
// AppConfigSchema in that it requires the envelope scalars (LOG,
// LOG_LEVEL, HOST, PORT, APIKEY, API_TIMEOUT_MS). Kept distinct because
// the frontend types this directly off the JSON it receives.
export const ConfigSchema = z.object({
  Providers: z.array(ProviderSchema),
  StatusLine: StatusLineConfigSchema.optional(),
  LOG: z.boolean(),
  LOG_LEVEL: z.string().nonempty(),
  // Absent when the operator never set it; the logger then uses 10.
  LOG_MAX_MB: z.number().positive().optional(),
  CLAUDE_PATH: z.string().nonempty(),
  HOST: z.string().nonempty(),
  PORT: z.number().int().positive(),
  APIKEY: z.string(),
  API_TIMEOUT_MS: z.number().int().nonnegative(),
  PROXY_URL: z.url(),
  // Archive capture switches. Optional here so an envelope written
  // before they existed still parses; ConfigEnvelopeSchema supplies the
  // defaults on the server side.
  CAPTURE_REQUESTS: z.boolean().optional(),
  CAPTURE_MESSAGES: z.boolean().optional(),
  REDACT_TOOL_ARGUMENTS: z.boolean().optional(),
  // Cloudflare Access. Both must be set for /api/* to verify assertions.
  ACCESS_TEAM_DOMAIN: z.string().optional(),
  ACCESS_AUD: z.string().optional(),
  // The active persona's id. Nullable, not just optional: composeUiConfig
  // emits null when nothing is active, and the UI sends null back to
  // clear it — an `undefined` is dropped by JSON.stringify and would
  // read as "leave the selection alone".
  ActivePersona: z.string().nullable().optional(),
  Personas: z.array(PersonaSchema).default([])
})
export type Config = z.infer<typeof ConfigSchema>

// applyUiConfig accepts a partial-update payload — Providers and the
// path scalars are all optional so any caller can send only the slice
// they're touching. Path scalars use EmptyStringToNullSchema to coerce
// the React-Hook-Form default of "" to null on the way in;
// pruneUnsetEnvelopePaths then collapses null to "key absent on disk".
// The .optional() suffix represents "this key was not included in this
// update" (vs. null / "" which both mean "explicitly unset").
export const ApplyConfigPayloadSchema = z
  .object({
    Providers: z.array(ProviderSchema).optional(),
    CLAUDE_PATH: EmptyStringToNullSchema.optional(),
    PROXY_URL: EmptyStringToNullSchema.optional(),
    // '' and null both clear the active persona; an absent key leaves
    // the current selection alone.
    ActivePersona: EmptyStringToNullSchema.optional(),
    Personas: z.array(PersonaSchema).optional()
  })
  .catchall(JsonValueSchema)
  .openapi('ApplyConfigPayload')

export const ApplyConfigResponseSchema = z
  .object({
    success: z.boolean(),
    message: z.string().nonempty(),
    warnings: z.array(z.string().nonempty()).optional()
  })
  .openapi('ApplyConfigResponse')
