/**
 * The model tiers routing speaks: what a requested model name is read as,
 * and what a provider's tier aliases are keyed by.
 *
 * Domain rather than api because the request path and the UI both read
 * it — see the note in ./index.ts.
 */

// The four families of Claude models CC (and everything upstream of
// Rialto that speaks the Anthropic wire format) actually sends: fable,
// opus, sonnet, haiku. The tier is derived from the requested model
// name with case-insensitive substring matching, so `claude-opus-4-7`
// tiers to `opus` regardless of version suffix.
export const REQUESTED_MODEL_TIERS = ['fable', 'opus', 'sonnet', 'haiku'] as const
export type RequestedModelTier = (typeof REQUESTED_MODEL_TIERS)[number]
