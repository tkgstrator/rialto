/**
 * What a Claude model refuses that the caller of a converted request could
 * not have known.
 *
 * On `/v1/messages` the client names the model it is talking to and shapes
 * its request for it. A request converted from another wire format was
 * shaped for whatever model the caller had in mind, and lands on the one
 * Rialto routed it to — a tier follows the newest switched-on model its
 * name says. Two OpenAI-family habits are a 400 on current Claude models
 * (claude-api skill, "Thinking & Effort" and "Common Pitfalls"):
 *
 *   - sampling parameters: `temperature` / `top_p` are removed on Opus 4.7
 *     and later, Sonnet 5 and later, Fable and Mythos (Sonnet 5.5 refuses
 *     any non-default value); Opus 4.6, Sonnet 4.6, Haiku 4.5 and older
 *     still take them, though not both at once;
 *   - forced tool use: `tool_choice` `any` / `tool` is refused by Opus 5.5,
 *     Sonnet 5.5, Fable 5.1 and Mythos 5.1.
 *
 * Read from the model id, as `shared/model-version.ts` reads "newest": the
 * families number their releases in the id. A Claude id this cannot place
 * gets the conservative answer (leave the parameter out); a non-Claude id —
 * a third-party Anthropic-compatible endpoint — keeps what the caller sent.
 */

import { parseModelVersion } from '@/shared/model-version'

type Family = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos'
const FAMILIES: readonly Family[] = ['opus', 'sonnet', 'haiku', 'fable', 'mythos']

const isClaude = (model: string): boolean => /claude/i.test(model)

function familyOf(model: string): Family | undefined {
  const lower = model.toLowerCase()
  return FAMILIES.find((family) => lower.includes(family))
}

// Whether the id's version is at least `major.minor`. A missing minor reads
// as 0, so `claude-opus-4` is 4.0.
function atLeast(model: string, major: number, minor: number): boolean {
  const { parts } = parseModelVersion(model)
  const first = parts.length > 0 ? parts[0] : 0
  const second = parts.length > 1 ? parts[1] : 0
  return first > major || (first === major && second >= minor)
}

/** Whether `temperature` / `top_p` may be sent to this model. */
export function acceptsSamplingParams(model: string): boolean {
  if (!isClaude(model)) return true
  // Every Claude 3 id leads with the generation (`claude-3-5-sonnet`).
  if (!atLeast(model, 4, 0)) return true
  const family = familyOf(model)
  if (family === 'opus') return !atLeast(model, 4, 7)
  if (family === 'sonnet' || family === 'haiku') return !atLeast(model, 5, 0)
  return false
}

/** Whether `tool_choice` may force a call (`any`, or one named tool). */
export function acceptsForcedToolChoice(model: string): boolean {
  if (!isClaude(model)) return true
  const family = familyOf(model)
  if (family === 'fable' || family === 'mythos') return !atLeast(model, 5, 1)
  if (family === 'opus' || family === 'sonnet') return !atLeast(model, 5, 5)
  return true
}

/**
 * The output cap sent when the caller gave none. Anthropic requires
 * `max_tokens`; the OpenAI wire formats make it optional and the Codex CLI
 * never sends one. 32 000 is Claude Code's own default and the smallest
 * ceiling in the Claude 4 generation (Opus 4 / 4.1), so every current model
 * takes it, while leaving the long agentic turns the Codex CLI asks for
 * room to finish.
 */
export const DEFAULT_MAX_TOKENS = 32000
