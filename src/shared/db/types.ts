/**
 * Plain-data constants and type re-exports for the Postgres-backed config
 * store. Zod schemas have been relocated to the `src/schemas` layers — see
 * `@/schemas/domain/router` (ScenarioKeySchema), `@/schemas/primitives/env`
 * (LogLevelSchema), and `@/schemas/domain/config` (ConfigEnvelopeSchema).
 *
 * - `SCENARIO_KEYS` mirrors the Prisma `ScenarioKey` enum and the legacy
 *   `Router.*` keys; its iteration order is the order used by the
 *   JSON-to-DB migration when seeding RouterSlot rows.
 * - `ENVELOPE_ENV_KEYS` is the whitelist of envelope scalars that may be
 *   mirrored onto `process.env` at boot.
 * - `DB_OWNED_CONFIG_KEYS` lists the keys PR #1 moves out of config.json
 *   into the database; `migrateFromJson` strips them after a successful
 *   seed.
 */

import type { ConfigEnvelope, ScenarioKey } from '@/schemas/domain'

// Re-export the relocated types so legacy `from '@/shared/db/types'`
// imports keep working without churn.
export type { ConfigEnvelope, ScenarioKey }

// --- Scenario key -----------------------------------------------------------

// Order matters: this is the iteration order used by the JSON-to-DB
// migration when seeding RouterSlot rows. The `background` scenario was
// removed in favour of a rules[] predicate on `default` — see
// `RouteRuleSchema`. Historical `RequestLog.scenario` rows may still
// carry the string 'background' but the enum no longer accepts it.
export const SCENARIO_KEYS = ['default', 'think', 'longContext', 'webSearch', 'image'] as const

// --- Config envelope --------------------------------------------------------

// Scalar envelope keys that may be mirrored onto process.env at boot.
// Object/array fields (Personas, StatusLine) are envelope-resident but
// never copied onto process.env, so they live in the schema
// (`@/schemas/domain/config`) but not in this list.
export const ENVELOPE_ENV_KEYS = [
  'HOST',
  'PORT',
  'APIKEY',
  'LOG',
  'LOG_LEVEL',
  'PROXY_URL',
  'API_TIMEOUT_MS',
  'CLAUDE_PATH',
  'NON_INTERACTIVE_MODE',
  // Mirrored onto process.env so the router reads the fresh value on the
  // next request without a full restart. ROUTER_MODE / ROUTER_SHADOW /
  // ROUTER_ROLLOUT_PCT sat here for the same reason and went with the
  // selector they switched between.
  'CROSS_PROVIDER_FALLBACK',
  // Archive capture switches. Mirrored onto process.env for the same
  // reason as the router knobs: the request-log writer reads them per
  // request, so turning capture off takes effect on the next call
  // rather than at the next restart — which matters, because the
  // reason to turn it off is usually that something is being recorded
  // right now that should not be.
  'CAPTURE_REQUESTS',
  'CAPTURE_MESSAGES',
  'REDACT_TOOL_ARGUMENTS',
  // Cloudflare Access. Envelope keys rather than environment-only so an
  // operator can turn Access on from the Access screen — the screen that
  // tells them to. A real environment value still wins, which is what a
  // container deployment needs.
  'ACCESS_TEAM_DOMAIN',
  'ACCESS_AUD'
] as const
export type EnvelopeEnvKey = (typeof ENVELOPE_ENV_KEYS)[number]

// Keys that PR #1 moves out of config.json into the database. Used by
// migrateFromJson to strip them after a successful seed.
export const DB_OWNED_CONFIG_KEYS = ['Providers', 'providers', 'Router'] as const
export type DbOwnedConfigKey = (typeof DB_OWNED_CONFIG_KEYS)[number]
