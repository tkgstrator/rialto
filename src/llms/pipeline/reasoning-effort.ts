/**
 * The reasoning effort an outbound body carries, for the request log.
 *
 * Read from the body `sendToProvider` actually dispatches — after
 * `applyBypassManualEffort` / `applyAdaptiveEffort` / `fitThinkingOff` have
 * rewritten it — so a row records what the vendor was told, not what the
 * client asked for. Reading the inbound body instead would log `null` for
 * every request Auto raised or lowered, which is exactly the traffic this
 * column exists to explain.
 */

const textOf = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)

// A malformed body (an array, a string, an `output_config` that is not an
// object) reads as "not there" rather than throwing: this runs on the
// fire-and-forget usage path, which must never disturb the response.
const fieldOf = (value: unknown, key: string): unknown =>
  value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined

/**
 * The effort level, or `null` when the body names none.
 *
 * The three places are one per upstream wire format (see `insertEffort` in
 * adaptive-effort.ts, which writes them), and a body only ever uses one:
 * Anthropic `output_config.effort`, Chat Completions `reasoning_effort`,
 * Responses / Codex `reasoning.effort`. Gemini spells it as a thinking
 * level or budget inside `generationConfig`, which is not read here.
 *
 * The value is returned as the vendor spelled it. It is not checked against
 * `SupportedEffortSchema`: the column is free text so that a level this build
 * has not heard of yet is still recorded instead of silently dropped.
 */
export function sentReasoningEffort(body: unknown): string | null {
  const candidates = [
    fieldOf(fieldOf(body, 'output_config'), 'effort'),
    fieldOf(body, 'reasoning_effort'),
    fieldOf(fieldOf(body, 'reasoning'), 'effort')
  ]
  for (const candidate of candidates) {
    const found = textOf(candidate)
    if (found !== null) return found
  }
  return null
}
