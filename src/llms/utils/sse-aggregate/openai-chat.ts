/**
 * OpenAI Chat-Completions SSE → the non-stream `chat.completion`
 * envelope.
 *
 * The `/v1/chat/completions` surface's `aggregateSse`. Also used by the
 * openai-responses endpoint transformer, which reads a chat stream on
 * its way to building a Responses envelope.
 */

import { parseSseEvents } from './parse'

/**
 * Aggregate an OpenAI Chat-Completions SSE stream into the non-stream
 * `chat.completion` envelope. Per-choice deltas merge into per-choice
 * message accumulators; tool_calls are keyed on the `index` field the
 * stream re-uses to say "this chunk belongs to the same call as earlier
 * chunks with the same index".
 */
export async function aggregateOpenAiChatSseToJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  const chunks: Record<string, unknown>[] = []
  for (const event of parseSseEvents(text)) {
    if (event !== null && typeof event === 'object') chunks.push(event as Record<string, unknown>)
  }
  return foldOpenAiChatChunks(chunks)
}

function foldOpenAiChatChunks(chunks: Record<string, unknown>[]): Record<string, unknown> {
  type ChoiceAcc = {
    role: string
    content: string
    toolCalls: Map<
      number,
      {
        id?: string
        type?: string
        // Not OpenAI's: the namespace a call from a Responses upstream was
        // made in (UnifiedToolCallSchema), stated on its first chunk. Kept
        // so the Responses envelope built from this one can hand it back.
        namespace?: string
        function: { name?: string; arguments: string }
      }
    >
    finishReason: string | null
  }
  const choices = new Map<number, ChoiceAcc>()
  let id: string | undefined
  let model: string | undefined
  let created: number | undefined
  let systemFingerprint: string | undefined
  let usage: Record<string, unknown> | undefined
  const getChoice = (idx: number): ChoiceAcc => {
    const existing = choices.get(idx)
    if (existing) return existing
    const fresh: ChoiceAcc = { role: 'assistant', content: '', toolCalls: new Map(), finishReason: null }
    choices.set(idx, fresh)
    return fresh
  }
  for (const chunk of chunks) {
    if (typeof chunk.id === 'string' && !id) id = chunk.id
    if (typeof chunk.model === 'string' && !model) model = chunk.model
    if (typeof chunk.created === 'number' && !created) created = chunk.created
    if (typeof chunk.system_fingerprint === 'string' && !systemFingerprint) systemFingerprint = chunk.system_fingerprint
    if (chunk.usage !== null && typeof chunk.usage === 'object') usage = chunk.usage as Record<string, unknown>
    if (!Array.isArray(chunk.choices)) continue
    for (const raw of chunk.choices) {
      if (raw === null || typeof raw !== 'object') continue
      const rawObj = raw as Record<string, unknown>
      const index = typeof rawObj.index === 'number' ? rawObj.index : 0
      const acc = getChoice(index)
      const delta = rawObj.delta
      if (delta !== null && typeof delta === 'object') {
        const deltaObj = delta as Record<string, unknown>
        if (typeof deltaObj.role === 'string') acc.role = deltaObj.role
        if (typeof deltaObj.content === 'string') acc.content += deltaObj.content
        if (Array.isArray(deltaObj.tool_calls)) {
          for (const tc of deltaObj.tool_calls) {
            if (tc === null || typeof tc !== 'object') continue
            const tcObj = tc as Record<string, unknown>
            const tcIndex = typeof tcObj.index === 'number' ? tcObj.index : 0
            const existing = acc.toolCalls.get(tcIndex) ?? { function: { arguments: '' } }
            if (typeof tcObj.id === 'string') existing.id = tcObj.id
            if (typeof tcObj.type === 'string') existing.type = tcObj.type
            if (typeof tcObj.namespace === 'string' && tcObj.namespace.length > 0) existing.namespace = tcObj.namespace
            const fn = tcObj.function
            if (fn !== null && typeof fn === 'object') {
              const fnObj = fn as Record<string, unknown>
              if (typeof fnObj.name === 'string') existing.function.name = fnObj.name
              if (typeof fnObj.arguments === 'string') existing.function.arguments += fnObj.arguments
            }
            acc.toolCalls.set(tcIndex, existing)
          }
        }
      }
      if (typeof rawObj.finish_reason === 'string') acc.finishReason = rawObj.finish_reason
    }
  }
  const outChoices = [...choices.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, acc]) => {
      const message: Record<string, unknown> = { role: acc.role, content: acc.content }
      if (acc.toolCalls.size > 0) {
        message.tool_calls = [...acc.toolCalls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, tc]) => ({
            id: tc.id,
            type: tc.type ?? 'function',
            ...(tc.namespace === undefined ? {} : { namespace: tc.namespace }),
            function: { name: tc.function.name, arguments: tc.function.arguments }
          }))
      }
      return { index, message, finish_reason: acc.finishReason }
    })
  const envelope: Record<string, unknown> = {
    id: id ?? '',
    object: 'chat.completion',
    created: created ?? Math.floor(Date.now() / 1000),
    model: model ?? '',
    choices: outChoices
  }
  if (systemFingerprint !== undefined) envelope.system_fingerprint = systemFingerprint
  if (usage !== undefined) envelope.usage = usage
  return envelope
}
