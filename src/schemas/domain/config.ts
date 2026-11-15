/**
 * The disk envelope — the config object the app owns rather than serves.
 *
 * ConfigEnvelopeSchema is the whitelist of what may stay in
 * ~/.rialto/config.json now that Providers live in the DB, so it is read
 * at boot before any HTTP surface exists. The /api/config wire shapes
 * derived from it are in api/config.ts.
 */

import { z } from '@hono/zod-openapi'
import { LogLevelSchema } from '@/schemas/primitives/env'
import { JsonValueSchema } from './preset'

// Whitelist of what is allowed to stay on disk in
// ~/.rialto/config.json once Providers have been moved into the DB.
export const ConfigEnvelopeSchema = z
  .object({
    HOST: z.string().default('127.0.0.1'),
    PORT: z.number().int().positive().default(3456),
    LOG: z.boolean().default(false),
    LOG_LEVEL: LogLevelSchema.default('info'),
    // Size in MB at which the log file rotates. Declared, and mirrored onto
    // process.env with the other scalars, because the logger reads it from
    // there: left to the catchall, a save reached the disk and never the
    // logger. Absent means the logger's own default (10).
    LOG_MAX_MB: z.coerce.number().positive().optional(),
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

    // Scheduler tick interval. Default 5 min matches the usage-cache
    // TTL; faster ticks just spin the weight recompute since upstream
    // /usage endpoints are cached. Lower bound 60s is for staging;
    // production should stay >= 300_000.
    ROUTING_SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(300_000)
  })
  // Any other keys we don't know about — keep them, don't drop them. A
  // key a retired feature wrote (`Router`, `CROSS_PROVIDER_FALLBACK`,
  // `CUSTOM_ROUTER_PATH`, `LiveRoutingName`, `ROUTER_MODE`, `Personas`,
  // `ActivePersona`, the `APIKEY` bootstrap token) survives a read this
  // way and is read by nothing; the next save prunes it.
  .catchall(JsonValueSchema)
export type ConfigEnvelope = z.infer<typeof ConfigEnvelopeSchema>
