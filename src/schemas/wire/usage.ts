/**
 * The vendor subscription-usage endpoints, as they answer.
 *
 * Deliberately loose — every field is `unknown` and read defensively —
 * because these are undocumented side-channel endpoints that change
 * without notice. The normalised shape the app serves is api/usage.ts.
 */

import { z } from '@hono/zod-openapi'

// Wire schemas for upstream HTTP shapes (kept for the usage fetch only).
export const ClaudeUsageWireSchema = z.object({
  five_hour: z.unknown().optional(),
  seven_day: z.unknown().optional(),
  seven_day_sonnet: z.unknown().optional(),
  seven_day_opus: z.unknown().optional(),
  extra_usage: z.unknown().optional(),
  // Per-limit rows the API now emits alongside the flat windows. Contains
  // session / weekly_all / weekly_scoped entries; the weekly_scoped ones
  // carry a per-model breakdown (via `scope.model.display_name`) that the
  // deprecated flat fields no longer surface.
  limits: z.unknown().optional()
})

export const CodexUsageWireSchema = z.object({
  plan_type: z.unknown().optional(),
  rate_limit: z.unknown().optional(),
  // Banked rate-limit resets: `{ available_count, applicable_available_count }`.
  // The second is how many could be spent right now — observed at 0 while
  // three were available on an account under no limit, so a reset only
  // applies while a window is actually spent.
  rate_limit_reset_credits: z.unknown().optional()
})

// GET /backend-api/wham/rate-limit-reset-credits. Shape taken from a live
// response (fixture: __tests__/fixtures/codex/rate-limit-reset-credits.json);
// only the fields Rialto reads are declared, and each loosely, because the
// endpoint is undocumented and can grow or rename around them.
export const CodexResetCreditWireSchema = z.object({
  id: z.string().nonempty(),
  status: z.string().nonempty(),
  // Absent reads as supported: the vendor still decides at spend time,
  // and dropping a credit it never flagged would hide a real one.
  is_supported_by_plan: z.boolean().default(true),
  granted_at: z.string().nonempty().nullable().optional(),
  expires_at: z.string().nonempty().nullable().optional()
})

export const CodexResetCreditsWireSchema = z.object({
  credits: z.array(CodexResetCreditWireSchema).default([]),
  available_count: z.number().int().nonnegative().optional()
})
export type CodexResetCreditsWire = z.infer<typeof CodexResetCreditsWireSchema>
