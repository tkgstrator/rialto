/**
 * The /api/config request and response shapes.
 *
 * All three are the disk envelope (domain/config.ts) widened with the
 * DB-resident Providers and Router, and they differ only in how strict
 * they are about the scalars — which is exactly the kind of difference
 * that belongs in the api layer rather than in the domain one.
 */

import { z } from '@hono/zod-openapi'
import { ConfigEnvelopeSchema, PersonaSchema } from '@/schemas/domain/config'
import { JsonValueSchema } from '@/schemas/domain/preset'
import { ProviderSchema } from '@/schemas/domain/provider'
import { RouterConfigSchema, RouterSchema } from '@/schemas/domain/router'
import { StatusLineConfigSchema } from '@/schemas/domain/status-line'
import { EmptyStringToNullSchema } from '@/schemas/primitives/common'

// API wire shape returned by /api/config and emitted by composeUiConfig
// / loadFullConfig. Extends ConfigEnvelopeSchema with DB-resident fields
// (Providers, Router) and overrides the optional path/url scalars so
// "unset" travels as null (composeUiConfig emits null when absent / ''
// on disk). The disk-only ActivePersona backing key is omitted — it
// surfaces solely as Router.persona. Registered as .openapi('Config')
// for the generated OpenAPI document.
export const AppConfigSchema = ConfigEnvelopeSchema.omit({ ActivePersona: true })
  .extend({
    Providers: z.array(ProviderSchema),
    Router: RouterSchema,
    PROXY_URL: z.string().nullable(),
    CLAUDE_PATH: z.string().nullable(),
    CUSTOM_ROUTER_PATH: z.string().nullable(),
    // The persona library stays top-level and is always a plain array
    // (default []); the active persona name rides on Router.persona.
    Personas: z.array(PersonaSchema).default([])
  })
  .openapi('Config')
export type AppConfig = z.infer<typeof AppConfigSchema>

// UI-side config shape consumed by components. Differs from
// AppConfigSchema in that it requires the envelope scalars (LOG,
// LOG_LEVEL, HOST, PORT, APIKEY, API_TIMEOUT_MS) and uses the broader
// RouterConfigSchema (allows the `custom` field). Kept distinct because
// the frontend types this directly off the JSON it receives.
export const ConfigSchema = z.object({
  Providers: z.array(ProviderSchema),
  Router: RouterConfigSchema,
  StatusLine: StatusLineConfigSchema.optional(),
  LOG: z.boolean(),
  LOG_LEVEL: z.string().nonempty(),
  CLAUDE_PATH: z.string().nonempty(),
  HOST: z.string().nonempty(),
  PORT: z.number().int().positive(),
  APIKEY: z.string(),
  API_TIMEOUT_MS: z.number().int().nonnegative(),
  PROXY_URL: z.url(),
  CUSTOM_ROUTER_PATH: z.string().nonempty().optional(),
  // Display name for the live routing. Optional; UI falls back to the
  // "Live" i18n label when absent.
  LiveRoutingName: z.string().optional(),
  CROSS_PROVIDER_FALLBACK: z.boolean().optional(),
  // Archive capture switches. Optional here so an envelope written
  // before they existed still parses; ConfigEnvelopeSchema supplies the
  // defaults on the server side.
  CAPTURE_REQUESTS: z.boolean().optional(),
  CAPTURE_MESSAGES: z.boolean().optional(),
  REDACT_TOOL_ARGUMENTS: z.boolean().optional(),
  // Cloudflare Access. Both must be set for /api/* to verify assertions.
  ACCESS_TEAM_DOMAIN: z.string().optional(),
  ACCESS_AUD: z.string().optional(),
  // Active persona lives on Router.persona (RouterConfigSchema), not as a
  // top-level field. The persona library stays top-level.
  Personas: z.array(PersonaSchema).default([])
})
export type Config = z.infer<typeof ConfigSchema>

// applyUiConfig accepts a partial-update payload — Providers/Router
// and the path scalars are all optional so any caller can send only
// the slice they're touching. Path scalars use EmptyStringToNullSchema
// to coerce the React-Hook-Form default of "" to null on the way in;
// pruneUnsetEnvelopePaths then collapses null to "key absent on disk".
// The .optional() suffix represents "this key was not included in
// this update" (vs. null / "" which both mean "explicitly unset").
export const ApplyConfigPayloadSchema = z
  .object({
    Providers: z.array(ProviderSchema).optional(),
    Router: RouterSchema.partial().optional(),
    CLAUDE_PATH: EmptyStringToNullSchema.optional(),
    PROXY_URL: EmptyStringToNullSchema.optional(),
    CUSTOM_ROUTER_PATH: EmptyStringToNullSchema.optional(),
    // The active persona arrives nested as Router.persona (RouterSchema,
    // empty string clears); only the persona library is top-level here.
    Personas: z.array(PersonaSchema).optional(),
    // Live routing display name. EmptyStringToNullSchema so the client
    // can clear it by sending ''; pruneUnsetEnvelopePaths drops null/''
    // from the on-disk envelope.
    LiveRoutingName: EmptyStringToNullSchema.optional()
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
