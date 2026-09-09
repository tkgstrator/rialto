/**
 * Readers for the signals a request carries on the wire.
 *
 * Split from `model-selection.ts` because these answer "what did the
 * client send?" and nothing more: none of them sees the router config,
 * a scenario or a rule. That is what lets the classifier and the rule
 * predicates share them without either owning them — `thinking`,
 * `output_config.effort` and the model-name tier are each read in
 * exactly one place, so the two callers cannot drift on what counts as
 * a thinking request.
 */

import type { RequestedModelTier } from '@/schemas/domain/router'
import type { RouterRequestBody } from './types'

// Whether the request opts INTO extended thinking. Anthropic's
// `thinking` field carries a `type` discriminator with three real
// values observed in Claude Code traffic:
//   - 'enabled'  → explicit budget request (older builds, haiku)
//   - 'adaptive' → newer builds (opus 4-7, sonnet 4-6) explicitly
//                  choose adaptive so the model decides at runtime
//                  whether (and how much) to think. Distinct from
//                  omitting the field entirely: an absent `thinking`
//                  falls back to adaptive on Anthropic's side but
//                  isn't an explicit client-intent signal.
//   - 'disabled' → the caller explicitly opted OUT of thinking
// The router treats `thinking` as a client-intent signal: the field
// being present with a non-disabled discriminator means the client
// asked to be routed as a thinking request. Omitting the field is
// NOT an opt-in even though Anthropic will still run adaptive server-
// side — cheap default traffic (Bash judger, tool calls, cache reads)
// omits the field and must land on the default lane. Boolean-truthy
// on the object routes 'disabled' to the think lane (wrong — Claude
// Code sends 'disabled' on every non-Plan-Mode request, silently
// redirecting cheap default traffic onto the expensive think slot).
// Checking `type !== 'disabled'` matches the pre-fix routing for
// 'enabled'/'adaptive' while excluding 'disabled'. A field that
// isn't an object at all (or a discriminator that isn't a string)
// is treated as "not thinking" — same as the boolean check for
// those shapes.
export function isThinkingEnabled(body: RouterRequestBody): boolean {
  const t = body.thinking
  if (t === null || typeof t !== 'object') return false
  const type: unknown = Reflect.get(t, 'type')
  if (typeof type !== 'string') return false
  return type !== 'disabled'
}

// Effort levels Claude Code sends in `output_config.effort`. The router
// reads this as a "how heavy is this work" hint to bias toward the
// Sonnet (default) lane for light traffic and escalate to the longContext
// (Opus) lane for heavy traffic. Per the Phase 6 plan an explicit
// low/medium suppresses the tier-based opus escalation so callers can
// override Claude Code's default model when the work is genuinely light.
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export function readEffort(body: RouterRequestBody): EffortLevel | undefined {
  const cfg = body.output_config
  if (cfg === null || typeof cfg !== 'object') return undefined
  const eff: unknown = Reflect.get(cfg, 'effort')
  if (typeof eff !== 'string') return undefined
  if (eff === 'low' || eff === 'medium' || eff === 'high' || eff === 'xhigh' || eff === 'max') return eff
  return undefined
}

export type ModelTier = 'opus' | 'sonnet' | 'haiku'

function classifyModelTier(model: string): ModelTier | undefined {
  if (typeof model !== 'string') return undefined
  const lower = model.toLowerCase()
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('haiku')) return 'haiku'
  return undefined
}

// Whether the request looks heavy enough to land in the Opus / long
// lane. Reads two signals in priority order:
//
//   1. `output_config.effort` — high/xhigh/max → heavy; low/medium →
//      explicitly light (suppresses the tier fallback so callers can
//      downgrade an opus request).
//   2. requested model tier — opus → heavy. Used only when effort is
//      absent so older Claude Code traffic still grades correctly.
//
// thinking presence and message size are NOT consulted here — they are
// already routed by the `think` / `longContext`-by-threshold lanes in
// classifyScenario and would double-count if we mixed them in.
export function isHeavyRequest(body: RouterRequestBody, signals?: { effort: EffortLevel | undefined }): boolean {
  // The effort reading comes from the caller's normalised signals when
  // there are any, so a non-Anthropic surface is graded on the field its
  // own clients actually send rather than on `output_config.effort`,
  // which only Claude Code writes.
  const effort = signals === undefined ? readEffort(body) : signals.effort
  if (effort === 'high' || effort === 'xhigh' || effort === 'max') return true
  if (effort === 'low' || effort === 'medium') return false
  return classifyModelTier(body.model) === 'opus'
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

// `globMatch` lived here. It matched a rule's `when.requestedModel`
// pattern (`*haiku*`) against the request, and had no other caller — the
// predicate stack went and took its only reader with it.
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
 * silently reroute existing subagent traffic onto the main-agent chain,
 * with nothing in the request to say why.
 */
const SUBAGENT_TAGS = ['RIALTO-SUBAGENT-MODEL', 'CCR-SUBAGENT-MODEL'] as const

// Detect a subagent tag in the second system block and strip it in place
// so the internal marker never leaks upstream. Returns true when the tag
// is present — its PRESENCE selects the subagent route; its VALUE is not
// used for routing. Only a well-formed (closed) tag is stripped, matching
// the old extractSubagentModel behaviour; a malformed (unclosed) tag
// still counts as present but is left untouched.
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
