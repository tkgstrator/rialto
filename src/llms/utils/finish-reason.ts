/**
 * Bidirectional stop/finish reason table shared between the Anthropic
 * and OpenAI response converters.
 *
 * The forward direction (OpenAI `finish_reason` → Anthropic
 * `stop_reason`) is a straight lookup with `end_turn` as the fallback.
 * The reverse direction (Anthropic → OpenAI) is intentionally
 * asymmetric: Anthropic's `stop_sequence` collapses to OpenAI `stop`
 * rather than `content_filter`, because sequence-triggered stops read
 * as normal completions to a Chat client. The override is captured
 * explicitly below so future additions stay in one place.
 */

// Canonical bidirectional pairs. Entries here are used verbatim for the
// OpenAI → Anthropic direction; the reverse direction consumes the same
// pairs but with the `stop_sequence` row overridden (see below).
const REASON_PAIRS: readonly (readonly [anthropic: string, openai: string])[] = [
  ['end_turn', 'stop'],
  ['max_tokens', 'length'],
  ['tool_use', 'tool_calls'],
  ['stop_sequence', 'content_filter']
]

const OPENAI_TO_ANTHROPIC: Record<string, string> = Object.fromEntries(
  REASON_PAIRS.map(([anthropic, openai]) => [openai, anthropic])
)

const ANTHROPIC_TO_OPENAI: Record<string, string> = {
  ...Object.fromEntries(REASON_PAIRS.map(([anthropic, openai]) => [anthropic, openai])),
  // Asymmetric override: sequence-triggered stops read as ordinary
  // completions to an OpenAI Chat client; there is no equivalent of
  // Anthropic's `stop_sequence` in the OpenAI taxonomy.
  stop_sequence: 'stop',
  // Reverse-only: Anthropic's safety decline is what OpenAI calls a
  // content filter, and running out of context window cuts the answer
  // short exactly as running out of `max_tokens` does. Read as `stop`,
  // both looked like a finished answer that happened to be empty.
  refusal: 'content_filter',
  model_context_window_exceeded: 'length'
}

/**
 * OpenAI `finish_reason` → Anthropic `stop_reason`. Missing / unknown
 * maps to `end_turn` so the client always sees a canonical value.
 */
export function openaiToAnthropicStopReason(finishReason: string | null | undefined): string {
  if (!finishReason) return 'end_turn'
  const mapped = OPENAI_TO_ANTHROPIC[finishReason]
  return mapped === undefined ? 'end_turn' : mapped
}

/**
 * Anthropic `stop_reason` → OpenAI `finish_reason`. Missing / unknown
 * maps to `stop` so the client always sees a canonical value.
 */
export function anthropicToOpenAiFinishReason(stopReason: string | null | undefined): string {
  if (!stopReason) return 'stop'
  const mapped = ANTHROPIC_TO_OPENAI[stopReason]
  return mapped === undefined ? 'stop' : mapped
}
