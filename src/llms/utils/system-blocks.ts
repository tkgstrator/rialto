/**
 * Anthropic-style top-level `system` normalisation shared across
 * transformer inbound hooks.
 *
 * OpenAI-flavoured callers don't emit `system` at the top level, but an
 * Anthropic-shape body reaching an OpenAI-endpoint transformer via
 * passthrough can leave one behind. `flattenSystemToText` reduces the
 * string-or-block-array form to a plain string; `absorbTopLevelSystem`
 * folds it into a leading `role:'system'` message and strips the
 * top-level field so it does not leak downstream.
 */

type MutableMessage = Record<string, unknown>
type BodyWithSystem = {
  system?: unknown
  messages?: Array<MutableMessage>
}

// Reduce Anthropic-style `system` (string OR array of `{text, ...}` blocks)
// to a plain string. Non-string blocks and blocks without `text` are
// skipped rather than throwing — the goal is defensive absorption, not
// strict Anthropic parsing.
export function flattenSystemToText(system: unknown): string {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  const parts: string[] = []
  for (const block of system) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (block === null || typeof block !== 'object') continue
    const text = Reflect.get(block, 'text')
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('\n\n')
}

// Absorb the top-level Anthropic-style `system` into a leading system
// message, then strip it. Idempotent: a body whose `messages[0]` is
// already a system message is left with only the top-level field
// removed. A body with no `system` (or a system that flattens to empty
// text) is left alone.
export function absorbTopLevelSystem(body: BodyWithSystem): void {
  if (body.system === undefined || body.system === null) return
  const systemText = flattenSystemToText(body.system)
  if (systemText.length > 0) {
    const messages = Array.isArray(body.messages) ? body.messages : []
    // Only prepend if the caller didn't already put a system message
    // at index 0 — avoids duplicating system text on retries.
    if (messages.length === 0 || messages[0]?.role !== 'system') {
      body.messages = [{ role: 'system', content: systemText }, ...messages]
    }
  }
  delete body.system
}
