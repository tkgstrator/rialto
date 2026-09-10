/**
 * Subscription usage windows as /api/usage serves them.
 *
 * The vendor responses these are built from are a different shape and
 * live in wire/usage.ts; everything here is already normalised across
 * Claude and Codex for the browser to render directly.
 */

import { z } from '@hono/zod-openapi'

export const ClaudeUsageWindowValueSchema = z.object({
  utilization: z.number(),
  resetsAt: z.string().nonempty().nullable()
})

export const ClaudeUsageWindowSchema = ClaudeUsageWindowValueSchema.nullable()

// One per-model scoped 7-day window (e.g. Fable, Sonnet, Opus) surfaced
// by the Anthropic OAuth usage API in its `limits[]` array. `modelName`
// is the vendor's display name verbatim so it can render as-is.
export const ClaudeScopedWindowSchema = z.object({
  modelName: z.string().nonempty(),
  utilization: z.number(),
  resetsAt: z.string().nonempty().nullable()
})

export const CodexUsageWindowValueSchema = z.object({
  usedPercent: z.number(),
  resetAt: z.string().nonempty().nullable(),
  windowSeconds: z.number().nullable()
})

export const CodexUsageWindowSchema = CodexUsageWindowValueSchema.nullable()

// Per-account usage snapshots. accountLabel is the human-readable name
// (userName ?? userEmail ?? userId) resolved at fetch time from the DB row.
// subAccountId is the stable SubAccount id, used by the UI to join usage
// bars onto the account roster from /api/subscriptions.
export const ClaudeUsageSchema = z.object({
  subAccountId: z.string().nonempty(),
  accountLabel: z.string(),
  fiveHour: ClaudeUsageWindowSchema,
  sevenDay: ClaudeUsageWindowSchema,
  sevenDaySonnet: ClaudeUsageWindowSchema,
  sevenDayOpus: ClaudeUsageWindowSchema,
  // Per-model weekly windows (Fable, Mythos, ...). Anthropic no longer
  // populates the flat `seven_day_sonnet`/`seven_day_opus` fields for most
  // plans and puts every scoped window in a `limits[]` array instead. This
  // list carries whatever the API returned, in order. Defaults to `[]` so
  // a value cached before this field existed still validates through the
  // response schema (missing key -> empty list).
  weeklyScoped: z.array(ClaudeScopedWindowSchema).default([]),
  extraUsageEnabled: z.boolean(),
  capturedAt: z.string().nonempty()
})

export const CodexUsageSchema = z.object({
  subAccountId: z.string().nonempty(),
  accountLabel: z.string(),
  planType: z.string().nonempty().nullable(),
  primary: CodexUsageWindowSchema,
  secondary: CodexUsageWindowSchema,
  capturedAt: z.string().nonempty()
})

// Empty array = no connected accounts for that vendor.
export const UsageResponseSchema = z
  .object({
    claude: z.array(ClaudeUsageSchema),
    codex: z.array(CodexUsageSchema)
  })
  .openapi('UsageResponse')

export const UsageHistoryResponseSchema = z
  .object({
    samples: z.array(
      z.object({
        metric: z.string().nonempty(),
        percent: z.number(),
        t: z.string().nonempty(),
        resetAt: z.string().nonempty().nullable()
      })
    )
  })
  .openapi('UsageHistoryResponse')

export const UsageHistoryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(30).default(7)
})

export const GetUsageInputSchema = z.object({
  // Ask upstream for every account instead of serving the 5-minute cache.
  // Only the Providers screen's Refresh button sets it; the poller and
  // /api/usage keep the cache so a page load never becomes an upstream call.
  forceRefresh: z.boolean().default(false)
})

export const GetUsageOutputSchema = z.object({
  usage: UsageResponseSchema
})
// ---- Inferred types ------------------------------------------------

export type ClaudeUsageWindow = z.infer<typeof ClaudeUsageWindowSchema>
export type ClaudeUsageWindowValue = z.infer<typeof ClaudeUsageWindowValueSchema>
export type ClaudeScopedWindow = z.infer<typeof ClaudeScopedWindowSchema>
export type CodexUsageWindow = z.infer<typeof CodexUsageWindowSchema>
export type CodexUsageWindowValue = z.infer<typeof CodexUsageWindowValueSchema>
export type ClaudeUsage = z.infer<typeof ClaudeUsageSchema>
export type CodexUsage = z.infer<typeof CodexUsageSchema>
export type UsageResponse = z.infer<typeof UsageResponseSchema>
export type GetUsageInput = z.input<typeof GetUsageInputSchema>
export type GetUsageOutput = z.infer<typeof GetUsageOutputSchema>
