import { z } from '@hono/zod-openapi'
import { TOKEN_PROVIDER_MODES } from '@/shared/access-token-policy'

/**
 * One model that picks its own billing method instead of following the
 * token's. Keyed by the bare model name, not by `provider,model`: the choice
 * it makes is between the subscription and the API key that both serve the
 * model, so one rule has to reach every provider row serving it.
 */
export const ModelProviderRuleSchema = z.object({
  model: z
    .string()
    .trim()
    .nonempty()
    .max(200)
    .regex(/^[^,]+$/),
  mode: z.enum(TOKEN_PROVIDER_MODES)
})

export type ModelProviderRule = z.infer<typeof ModelProviderRuleSchema>

// One rule per model: two would leave the request path to pick between them.
export const ModelProviderRulesSchema = z
  .array(ModelProviderRuleSchema)
  .max(1000)
  .refine((rules) => new Set(rules.map((rule) => rule.model)).size === rules.length, {
    message: 'Each model may have only one provider rule.'
  })

/**
 * Reads the stored rules. The column is JSON, so a row written by hand or by
 * a future version is checked rather than trusted; a column that does not
 * parse behaves as having no rules, which leaves the token-wide setting in
 * charge instead of refusing the token outright.
 */
export function parseModelProviderRules(value: unknown): ModelProviderRule[] {
  const parsed = ModelProviderRulesSchema.safeParse(value)
  return parsed.success ? parsed.data : []
}
