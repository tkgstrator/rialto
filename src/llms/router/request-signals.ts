/**
 * Readers for what a request carries on the wire, one question each.
 *
 * None of them sees the inbound surface: they answer "what did the client
 * send?" and nothing more.
 */

import type { RouterRequestBody } from './types'

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
// Claude Code itself marks the subagents it spawns: system[0] is the
// `x-anthropic-billing-header` line and carries `cc_is_subagent=true` only
// for them (observed in the request archive). Real subagents never carry
// the Rialto tag, so this is the signal that actually fires.
const CLAUDE_CODE_SUBAGENT_MARKER = 'cc_is_subagent=true'

function hasClaudeCodeSubagentMarker(system: RouterRequestBody['system']): boolean {
  if (!Array.isArray(system)) return false
  const text = system[0]?.text
  return (
    typeof text === 'string' &&
    text.startsWith('x-anthropic-billing-header:') &&
    text.includes(CLAUDE_CODE_SUBAGENT_MARKER)
  )
}

export function stripSubagentTag(system: RouterRequestBody['system']): boolean {
  if (hasClaudeCodeSubagentMarker(system)) return true
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
