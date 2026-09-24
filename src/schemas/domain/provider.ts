/**
 * A configured upstream vendor, as the app models it: credentials, auth
 * mode, the models it exposes and the per-model overrides the router
 * consults.
 *
 * This is the widest of the three Provider projections in the tree. The
 * pipeline reads a 6-field subset (domain/pipeline.ts RuntimeProvider)
 * and an exported preset carries a 5-field subset (domain/preset.ts
 * PresetProvider) — deliberately narrower, so a shared preset cannot
 * leak auth modes or sub-accounts. They are projections, not copies.
 */

import { z } from '@hono/zod-openapi'

export const AuthModeSchema = z.enum(['api_key', 'subscription']).openapi('AuthMode')
export const ProviderAuthModeSchema = AuthModeSchema
export type ProviderAuthMode = z.infer<typeof ProviderAuthModeSchema>

/**
 * The `Provider.transformer` JSONB blob.
 *
 * The name is historical: it no longer selects transformers. The chain a
 * provider runs is derived from `api_style` + `auth_mode`
 * (`shared/transformer-chain.ts`) and is not configurable, so nothing
 * here declares one. What the column actually holds today is two flags
 * the schema has yet to promote to columns of their own —
 * `_disabledModels` (the wire view of `Model.enabled`) and
 * `providerEnabled` — plus the subscription credential keys the runtime
 * overlay grafts on. Hence a shape with no declared members and a
 * catchall.
 */
export const ProviderTransformerSchema = z.object({}).catchall(z.any())
export type ProviderTransformer = z.infer<typeof ProviderTransformerSchema>

export const ProviderSchema = z
  .object({
    name: z.string().nonempty(),
    enabled: z.boolean().default(true),
    api_base_url: z.url(),
    // null when the key is unset (fresh seed / cleared). A present
    // value is an arbitrary secret, so no .nonempty() here.
    api_key: z.string().nullable(),
    auth_mode: AuthModeSchema,
    // Request wire-format the provider's chat endpoint expects. Mirrored
    // from the DB `Provider.apiStyle` column. Optional on the wire so
    // legacy fixtures / older configs still parse; every runtime provider
    // seeded by src/services/config/seed.ts sets an explicit value.
    api_style: z.enum(['openai_chat', 'openai_responses', 'anthropic', 'gemini']).optional(),
    models: z.array(z.string().nonempty()),
    deprecatedModels: z.array(z.string().nonempty()).optional(),
    modelTestStatus: z
      .record(
        z.string().nonempty(),
        z.object({ status: z.enum(['unknown', 'ok', 'fail']), passedAt: z.string().nullable() })
      )
      .optional(),
    modelContextWindows: z.record(z.string().nonempty(), z.number().int().positive()).optional(),
    // Per-model USD/1M prices sourced from the DB (scraped, or seeded from
    // the llm-prices.json snapshot by backfillStaticPrices). The Models
    // dashboard reads prices only from here — there is no frontend static
    // fallback. null legs mean the vendor doesn't publish that side.
    modelPrices: z
      .record(
        z.string().nonempty(),
        z.object({ inputPer1M: z.number().nullable(), outputPer1M: z.number().nullable() })
      )
      .optional(),
    // Per-model manual reasoning-effort override consumed at request
    // build time. Absent keys pass through untouched (vendor default).
    modelReasoningEfforts: z
      .record(z.string().nonempty(), z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']))
      .optional(),
    // Per-model apiStyle override (Model.apiStyle in the DB). Only
    // populated for models whose column is non-null — a single api_key
    // provider hosts both openai_chat and openai_responses models
    // (codex-family), and the router's peer-fallback expander needs the
    // per-model override to filter correctly.
    modelApiStyles: z
      .record(z.string().nonempty(), z.enum(['openai_chat', 'openai_responses', 'anthropic', 'gemini']))
      .optional(),
    transformer: ProviderTransformerSchema.optional(),
    // Per-account enable/disable for subscription providers. Absent on
    // api_key providers. Only the { id, enabled } pairs the UI sends
    // through get applied — never used to add/remove rows, which is the
    // sync service's job.
    subscription_accounts: z.array(z.object({ id: z.string().nonempty(), enabled: z.boolean() })).optional()
  })
  .openapi('Provider')
export type Provider = z.infer<typeof ProviderSchema>
