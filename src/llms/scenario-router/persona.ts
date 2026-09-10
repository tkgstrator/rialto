/**
 * Persona / global system-prompt injection.
 *
 * Resolves the active persona's prompt text and appends it to the
 * request's `system` field cache-safely (inside the last
 * `cache_control`-bearing block, so the append doesn't cost an extra
 * Anthropic cache breakpoint).
 */

import type { Persona } from '@/schemas/domain/config'
import type { ConfigStore } from '../registry/config'
import type { TokenizeSystem } from '../tokenizers/base'

// Whether a system block carries a truthy `cache_control` discriminator.
// TokenizeSystemBlock doesn't model `cache_control` (the tokenizer
// ignores it), so we probe the runtime value instead of casting.
function hasCacheControl(block: unknown): boolean {
  if (block === null || typeof block !== 'object' || !('cache_control' in block)) return false
  const cacheControl: unknown = Reflect.get(block, 'cache_control')
  return cacheControl !== null && cacheControl !== undefined
}

// Read a block's `text` only when it's a plain string (Anthropic also
// allows string[] per TokenizeSystemBlock — we append solely to string
// blocks so the cached prefix stays a single coherent text).
function stringTextOf(block: unknown): string | undefined {
  if (block === null || typeof block !== 'object' || !('text' in block)) return undefined
  const text: unknown = Reflect.get(block, 'text')
  return typeof text === 'string' ? text : undefined
}

/**
 * Resolve the active persona's prompt text.
 *
 * Reads the top-level `ActivePersona` (the active persona's uuid id) off
 * the ConfigStore and looks it up in the `Personas` library, returning
 * the matching persona's `prompt`. Falls back to a name match so a
 * pre-migration config that still stores a name keeps resolving.
 * Returns '' when no persona is active, nothing matches, or the prompt
 * is empty — applyGlobalSystemPrompt treats '' as a no-op so the cached
 * prefix stays byte-stable.
 */
export function resolveActivePersonaPrompt(config: ConfigStore): string {
  const active = config.get<unknown>('ActivePersona')
  if (typeof active !== 'string' || active.length === 0) return ''
  const personas = config.get<Persona[]>('Personas', [])
  const byId = personas.find((p) => p.id === active)
  const match = byId !== undefined ? byId : personas.find((p) => p.name === active)
  return match !== undefined ? match.prompt : ''
}

/**
 * Append the global persona to the request's `system` cache-safely.
 *
 * The persona is appended to the LAST system block carrying
 * `cache_control` (falling back to the last string text block) so it
 * stays INSIDE the cached prefix and consumes no extra cache breakpoint.
 * The append is deterministic — same prompt yields the same bytes every
 * request — which is what preserves Anthropic's prompt cache.
 *
 * Array blocks are mutated in place (matching stripSubagentTag);
 * string / undefined system values can't be mutated in place, so the
 * new value is returned and the caller assigns it back.
 */
export function applyGlobalSystemPrompt(
  system: TokenizeSystem | undefined,
  prompt: string
): TokenizeSystem | undefined {
  if (prompt.trim().length === 0) return system

  if (system === undefined) return prompt

  if (typeof system === 'string') return `${system}\n\n${prompt}`

  if (system.length === 0) return prompt

  // Prefer the last cache_control-bearing block so the persona lands
  // inside the cached prefix; otherwise fall back to the last string
  // text block.
  const withCacheText = system.filter((block) => hasCacheControl(block) && stringTextOf(block) !== undefined)
  const withText = system.filter((block) => stringTextOf(block) !== undefined)
  const target = withCacheText.length > 0 ? withCacheText[withCacheText.length - 1] : withText[withText.length - 1]
  if (target === undefined) return system

  const current = stringTextOf(target)
  if (current === undefined) return system
  target.text = `${current}\n\n${prompt}`
  return system
}
