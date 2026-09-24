/**
 * Readers for what a request carries on the wire, one question each.
 *
 * None of them sees the routes or the inbound surface: they answer
 * "what did the client send?" and nothing more. That is what lets the
 * tier router and the services beside it share `tierOf` without any of
 * them owning it — the model-name tier is read in exactly one place, so
 * no two callers can drift on which tier a model belongs to.
 */

import type { RequestedModelTier } from '@/schemas/domain/router'
import type { RouterRequestBody } from './types'

/**
 * Whether the caller opted into extended thinking — the Think scenario.
 *
 * Presence of `thinking` is the opt-in and `type: 'disabled'` the
 * explicit opt-out; 'enabled' and 'adaptive' both count. A field that is
 * not an object, or a discriminator that is not a string, is "not
 * thinking", so a malformed body never lands on the Think list.
 */
export function isThinkingEnabled(body: RouterRequestBody): boolean {
  const t = body.thinking
  if (t === null || typeof t !== 'object') return false
  const type: unknown = Reflect.get(t, 'type')
  if (typeof type !== 'string') return false
  return type !== 'disabled'
}

// Bucket a model string into one of the four CC families. Case-
// insensitive substring match: `claude-opus-4-7` → 'opus', `gpt-5` →
// undefined. Order matters — `fable` is checked before `opus` because
// a hypothetical `claude-fable-opus-mix` string should still tier to
// fable (the family the user explicitly asked for).
export function tierOf(model: string): RequestedModelTier | undefined {
  if (typeof model !== 'string') return undefined
  const lower = model.toLowerCase()
  if (lower.includes('fable')) return 'fable'
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('haiku')) return 'haiku'
  return undefined
}

// Whether an Anthropic tool entry is the hosted web-search tool.
// Prefix-matched because Anthropic versions the type
// (`web_search_20250305`) and a new version must not slip past the
// router's web-search gate.
export function isWebSearchTool(tool: unknown): tool is { type: string } {
  if (tool === null || typeof tool !== 'object' || !('type' in tool)) return false
  const type: unknown = Reflect.get(tool, 'type')
  return typeof type === 'string' && type.startsWith('web_search')
}

/**
 * Tag names that mark a request as subagent traffic, newest first.
 *
 * This is an EXTERNAL CONTRACT: the string lives in prompts users have
 * already written into their own subagent definitions. The rename adds
 * a name, it does not replace one — dropping the old spelling would
 * send the marker upstream inside the caller's prompt and record that
 * traffic as main-agent, with nothing in the request to say why.
 */
const SUBAGENT_TAGS = ['RIALTO-SUBAGENT-MODEL', 'CCR-SUBAGENT-MODEL'] as const

// Detect a subagent tag in the second system block and strip it in place
// so the internal marker never leaks upstream. Returns true when the tag
// is present — its PRESENCE marks the request as subagent traffic on the
// usage record; its VALUE is not read. Only a well-formed (closed) tag is
// stripped, matching the old extractSubagentModel behaviour; a malformed
// (unclosed) tag still counts as present but is left untouched.
export function stripSubagentTag(system: RouterRequestBody['system']): boolean {
  if (!Array.isArray(system) || system.length < 2) return false
  const block = system[1]
  const text = typeof block?.text === 'string' ? block.text : undefined
  if (text === undefined) return false

  const tag = SUBAGENT_TAGS.find((name) => text.startsWith(`<${name}>`))
  if (tag === undefined) return false

  const match = text.match(new RegExp(`<${tag}>(.*?)</${tag}>`, 's'))
  if (match) {
    block.text = text.replace(`<${tag}>${match[1]}</${tag}>`, '')
  }
  return true
}
