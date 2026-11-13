/**
 * The Claude family a model name says, which is the tier it serves.
 *
 * Read in exactly one place so the per-family usage windows cannot drift
 * on which family a model belongs to.
 */

import type { RequestedModelTier } from '@/schemas/domain/router'

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
