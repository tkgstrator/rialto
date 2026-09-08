/**
 * The persona library and the disk envelope — the two config objects
 * the app owns rather than serves.
 *
 * ConfigEnvelopeSchema is the whitelist of what may stay in
 * ~/.rialto/config.json now that Providers and Router live
 * in the DB, so it is read at boot before any HTTP surface exists. The
 * /api/config wire shapes derived from it are in api/config.ts.
 */

import { z } from '@hono/zod-openapi'
import { LogLevelSchema } from '@/schemas/primitives/env'
import { JsonValueSchema } from './preset'

// A single persona in the library. `id` is the stable uuid key every
// reference points at — the URL (/personas/view|edit/:id), the active
// selection (Router.persona), and the server-side prompt lookup — so the
// `name` is a free-form display label and need not be unique. `id` is
// optional in the schema only for back-compat: configs written before
// the uuid migration have personas without one; the boot migration
// (migratePersonaKeys) and the UI both backfill a uuid on load.
export const PersonaSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().nonempty(),
    prompt: z.string()
  })
  .openapi('Persona')
export type Persona = z.infer<typeof PersonaSchema>

// Whitelist of what is allowed to stay on disk in
// ~/.rialto/config.json once Providers / Router have been
// moved into the DB.
export const ConfigEnvelopeSchema = z
  .object({
    HOST: z.string().default('127.0.0.1'),
    PORT: z.number().int().positive().default(3456),
    // Optional break-glass credential for /api/*. Absent on a fresh
    // install; an operator sets it deliberately or not at all.
    APIKEY: z.string().default(''),
    LOG: z.boolean().default(false),
    LOG_LEVEL: LogLevelSchema.default('info'),
    PROXY_URL: z.string().default(''),
    API_TIMEOUT_MS: z.coerce.number().int().nonnegative().optional(),
    CLAUDE_PATH: z.string().default(''),
    NON_INTERACTIVE_MODE: z.boolean().optional(),

    // What the archive is allowed to keep. Default on, matching the
    // unconditional capture that predates these keys, so an existing
    // install records exactly what it recorded before.
    //
    // `REDACT_TOOL_ARGUMENTS` defaults OFF because turning it on loses
    // information that cannot be recovered later; an operator who needs
    // it will say so.
    CAPTURE_REQUESTS: z.boolean().default(true),
    CAPTURE_MESSAGES: z.boolean().default(true),
    REDACT_TOOL_ARGUMENTS: z.boolean().default(false),

    // Cloudflare Access, for /api/*. BOTH are required to enable
    // verification: checking a signature without checking the audience
    // would accept a token minted for any other application on the same
    // team, so a half configuration deliberately enables nothing.
    ACCESS_TEAM_DOMAIN: z.string().default(''),
    ACCESS_AUD: z.string().default(''),

    // Disk-only backing store for the active persona's id (surfaced on
    // the wire as `Router.persona`, not as a top-level field). Absent /
    // empty means "no persona". Round-trips through the disk envelope
    // like the other optional scalars (see CUSTOM_ROUTER_PATH).
    ActivePersona: z.string().optional(),
    // User-editable display name for the live routing (the RouterSlot
    // rows). Presented on the Routing Library grid + Live editor. Absent
    // / empty → UI falls back to the "Live" i18n label. Auto-populated
    // when a preset is applied to Live so the card reads as "Work"
    // instead of the generic "Live".
    LiveRoutingName: z.string().optional(),

    // Object-shaped envelope members: they stay on disk rather than
    // moving to the DB, and are never mirrored onto process.env.
    // Personas is the named persona library.
    Personas: z.array(PersonaSchema).default([]),
    StatusLine: JsonValueSchema.optional(),

    // ROUTER_MODE / ROUTER_SHADOW / ROUTER_ROLLOUT_PCT are gone. They
    // existed to move traffic from the scenario router onto the chain a
    // percentage at a time, and to run the two side by side while that
    // happened. With one selector left they described a migration that
    // is over. A stale value on disk is preserved by the `.catchall`
    // below and read by nothing.
    //
    // Scheduler tick interval. Default 5 min matches the usage-cache
    // TTL; faster ticks just spin the weight recompute since upstream
    // /usage endpoints are cached. Lower bound 60s is for
    // shadow/staging; production should stay >= 300_000.
    ROUTING_SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(300_000),
    // When true, the failover walker auto-appends peer entries with the
    // same Model.name on OpenAI-family providers (apiStyle openai_chat /
    // openai_responses) after each explicit chain entry. Off by default
    // — enable when you have the same model surfaced by multiple
    // OpenAI-compatible providers and want a 429 on one to hop to the
    // peer without hand-writing the chain.
    CROSS_PROVIDER_FALLBACK: z.coerce.boolean().default(false)
  })
  // Any other keys we don't know about — keep them, don't drop them.
  .catchall(JsonValueSchema)
export type ConfigEnvelope = z.infer<typeof ConfigEnvelopeSchema>
