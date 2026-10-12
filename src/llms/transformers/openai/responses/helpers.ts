/**
 * Small stateless helpers shared across the OpenAI Responses request /
 * response conversion modules.
 */

import type { ResponsesStreamEvent } from '@/schemas/wire/openai/responses'
export function newChatcmplId(seed: string | undefined): string {
  if (seed && seed.length > 0) return seed
  return `chatcmpl-${Date.now()}`
}

export function stringDeltaOrEmpty(delta: ResponsesStreamEvent['delta']): string {
  return typeof delta === 'string' ? delta : ''
}

/**
 * Return the first defined string from a candidate list. Used to
 * select an upstream identifier (call_id, id) without a `??` chain.
 */
export function firstDefined(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * A call's `namespace`, as a fragment to spread into the item or tool call
 * being built: `{ namespace }` for a non-empty string, `{}` for anything
 * else. Absent, `null` and `""` all mean a top-level tool, and a call
 * outside a namespace has to come out with no key at all — byte-identical
 * to every call before namespaces were carried.
 */
export function namespaceOf(value: unknown): { namespace?: string } {
  return typeof value === 'string' && value.length > 0 ? { namespace: value } : {}
}

/**
 * Returns the provided model name, or a neutral placeholder when upstream
 * omitted it. Keeps the wire shape stable for downstream consumers that
 * expect a non-empty model, without naming a model the upstream never
 * said (the Anthropic stream uses the same placeholder).
 */
export function modelOr(model: string | undefined): string {
  return typeof model === 'string' && model.length > 0 ? model : 'unknown'
}
