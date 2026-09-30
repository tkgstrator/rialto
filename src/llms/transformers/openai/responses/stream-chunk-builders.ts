import type { MessageContent } from '@/schemas/domain/unified'
import type { ResponsesStreamEvent } from '@/schemas/wire/openai/responses'
import { nowSeconds } from '../../../utils/time'
import { firstDefined, modelOr, newChatcmplId, stringDeltaOrEmpty } from './helpers'

export function buildTextDeltaChunk(
  data: ResponsesStreamEvent,
  getCurrentIndex: (eventType: string) => number
): Record<string, unknown> {
  return {
    id: newChatcmplId(data.item_id),
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model: data.response?.model,
    choices: [
      {
        index: getCurrentIndex(data.type),
        delta: { content: stringDeltaOrEmpty(data.delta) },
        finish_reason: null
      }
    ]
  }
}

export function buildToolCallAddedChunk(
  data: ResponsesStreamEvent,
  getCurrentIndex: (eventType: string) => number,
  slot: number
): Record<string, unknown> {
  const item = data.item
  const toolName = item?.name
  if (toolName === undefined) {
    throw new Error(`OpenAI Responses stream: ${item?.type} output is missing name`)
  }
  const callId = firstDefined([item?.call_id, item?.id])
  return {
    id: newChatcmplId(callId),
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model: modelOr(data.response?.model),
    choices: [
      {
        index: getCurrentIndex(data.type),
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: slot,
              id: callId,
              function: {
                name: toolName,
                arguments: ''
              },
              // The kind is only stated on this first chunk; the
              // aggregator keeps it while the payload deltas accumulate,
              // and the Responses inbound converter reads it to decide
              // which output item the caller gets back.
              type: item?.type === 'custom_tool_call' ? 'custom' : 'function'
            }
          ]
        },
        finish_reason: null
      }
    ]
  }
}

export function buildMessageAddedChunk(
  data: ResponsesStreamEvent,
  getCurrentIndex: (eventType: string) => number
): Record<string, unknown> | null {
  const item = data.item
  if (!item) return null

  const contentItems: MessageContent[] = []
  const itemContent = item.content
  if (Array.isArray(itemContent)) {
    itemContent.forEach((entry) => {
      if (entry.type === 'output_text' && typeof entry.text === 'string') {
        contentItems.push({
          type: 'text',
          text: entry.text
        })
      }
    })
  }

  const delta: { role: string; content?: string | MessageContent[] } = { role: 'assistant' }
  if (contentItems.length === 1 && contentItems[0].type === 'text') {
    delta.content = contentItems[0].text
  } else if (contentItems.length > 0) {
    delta.content = contentItems
  }
  if (!delta.content) return null

  return {
    id: newChatcmplId(item.id),
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model: data.response?.model,
    choices: [
      {
        index: getCurrentIndex(data.type),
        delta,
        finish_reason: null
      }
    ]
  }
}

export function buildAnnotationChunk(
  data: ResponsesStreamEvent,
  getCurrentIndex: (eventType: string) => number
): Record<string, unknown> {
  // ResponsesAnnotationSchema fills missing fields with empty
  // defaults; if `annotation` itself is undefined we synthesise a
  // schema-shaped placeholder so the downstream emit stays uniform.
  const empty = { url: '', title: '', start_index: 0, end_index: 0 }
  const annotation = data.annotation ? data.annotation : empty
  return {
    id: newChatcmplId(data.item_id),
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model: modelOr(data.response?.model),
    choices: [
      {
        index: getCurrentIndex(data.type),
        delta: {
          annotations: [
            {
              type: 'url_citation',
              url_citation: {
                url: annotation.url,
                title: annotation.title,
                content: '',
                start_index: annotation.start_index,
                end_index: annotation.end_index
              }
            }
          ]
        },
        finish_reason: null
      }
    ]
  }
}

// Serves both call kinds: the aggregator concatenates onto whichever
// call the `added` chunk opened, and a delta chunk restating the kind
// would say nothing the accumulator does not already hold.
export function buildToolCallPayloadDeltaChunk(
  data: ResponsesStreamEvent,
  getCurrentIndex: (eventType: string) => number,
  slot: number
): Record<string, unknown> {
  return {
    id: newChatcmplId(data.item_id),
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model: modelOr(data.response?.model),
    choices: [
      {
        index: getCurrentIndex(data.type),
        delta: {
          tool_calls: [
            {
              index: slot,
              function: {
                arguments: stringDeltaOrEmpty(data.delta)
              }
            }
          ]
        },
        finish_reason: null
      }
    ]
  }
}
