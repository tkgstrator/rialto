import { type ThinkingEffortKey, ThinkingEffortKeySchema } from '@/schemas/domain/model-capability'
import type { ResolvedProvider } from '../registry/provider'

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object(value) : null

// The effort the body actually sends, as the probe recorded it: 'default'
// when none is sent. Null for a level this build cannot name, which is
// left for the upstream to judge.
function effortKey(output: unknown): ThinkingEffortKey | null {
  const config = recordOf(output)
  if (config === null || config.effort === undefined) return 'default'
  const parsed = ThinkingEffortKeySchema.safeParse(config.effort)
  return parsed.success && parsed.data !== 'default' ? parsed.data : null
}

/**
 * Turn a caller's "no thinking" into what the target model accepts.
 *
 * `thinking: {type: "disabled"}` is how a caller opts out of thinking, and
 * it used to go upstream untouched. But the model a request lands on is
 * Rialto's choice — a tier follows the newest switched-on model its name
 * says — and newer Claude models refuse that value: Sonnet 5.5 takes only
 * `between_tools` (and only at effort high or below), Opus 5.5 and Fable
 * take neither. Forwarding it turned a routing decision into a 400.
 *
 * What each model accepts was probed once (ModelCapability, surfaced as
 * `modelThinkingOff`); a model not probed yet is left alone. Runs after
 * every effort override, because the verdict depends on the effort that
 * is actually sent. Returns what it did, for the request log.
 */
export function fitThinkingOff(body: unknown, provider: ResolvedProvider): 'between_tools' | 'dropped' | null {
  const shaped = recordOf(body)
  if (shaped === null || typeof shaped.model !== 'string') return null
  if (recordOf(shaped.thinking)?.type !== 'disabled') return null
  const accepted = provider.modelThinkingOff?.[shaped.model]
  if (accepted === undefined) return null
  const effort = effortKey(shaped.output_config)
  if (effort === null || accepted.disabled.includes(effort)) return null
  if (accepted.betweenTools.includes(effort)) {
    shaped.thinking = { type: 'between_tools' }
    return 'between_tools'
  }
  // The model cannot switch thinking off at this effort. Leaving `thinking`
  // out is the closest it allows: adaptive, held down by the effort sent.
  delete shaped.thinking
  return 'dropped'
}
