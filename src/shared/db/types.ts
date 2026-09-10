/**
 * Plain-data constants and type re-exports for the Postgres-backed config
 * store. Zod schemas have been relocated to the `src/schemas` layers — see
 * `@/schemas/domain/router` (ScenarioKeySchema), `@/schemas/primitives/env`
 * (LogLevelSchema), and `@/schemas/domain/config` (ConfigEnvelopeSchema).
 *
 * - `SCENARIO_KEYS` mirrors the Prisma `ScenarioKey` enum; every chain
 *   is split on it.
 * - `ENVELOPE_ENV_KEYS` is the whitelist of envelope scalars that may be
 *   mirrored onto `process.env` at boot.
 */

import type { ConfigEnvelope } from '@/schemas/domain'

// Re-export the relocated type so legacy `from '@/shared/db/types'`
// imports keep working without churn.
export type { ConfigEnvelope }

// --- Scenario key -----------------------------------------------------------

// The order the Routing screen lists the lanes in. The `background`
// scenario was folded into `default`. Historical `RequestLog.scenario`
// rows may still carry the string 'background' but the enum no longer
// accepts it.
export const SCENARIO_KEYS = ['default', 'think', 'longContext', 'webSearch', 'image'] as const

// --- Config envelope --------------------------------------------------------

// Scalar envelope keys that may be mirrored onto process.env at boot.
// Object/array fields (Personas, StatusLine) are envelope-resident but
// never copied onto process.env, so they live in the schema
// (`@/schemas/domain/config`) but not in this list.
export const ENVELOPE_ENV_KEYS = [
  'HOST',
  'PORT',
  'LOG',
  'LOG_LEVEL',
  // Rotation size. syncLoggerFromEnv re-reads it after a save, so a change
  // from Settings → Logging re-sizes the file sink without a restart.
  'LOG_MAX_MB',
  'PROXY_URL',
  'API_TIMEOUT_MS',
  'CLAUDE_PATH',
  'NON_INTERACTIVE_MODE',
  // Archive capture switches. Mirrored onto process.env so the
  // request-log writer, which reads them per request, sees a change on
  // the next call rather than at the next restart — which matters,
  // because the reason to turn capture off is usually that something is
  // being recorded right now that should not be.
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
