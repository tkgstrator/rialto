/**
 * OpenAI Responses blocking-JSON response conversion.
 *
 * Converts a parsed Responses-API JSON payload (`object: 'response'`)
 * into the chat-completion JSON shape the rest of the pipeline expects.
 */

import type { Logger } from 'pino'
import type { MessageContent } from '@/schemas/domain/unified'
import type {
  ResponsesAPIOutputContent,
  ResponsesAPIOutputItem,
  ResponsesAPIPayload
} from '@/schemas/wire/openai/responses'
import { firstDefined, newChatcmplId } from './helpers'

export function convertResponseToChat(responseData: ResponsesAPIPayload, logger?: Logger): Record<string, unknown> {
  const messageOutput = responseData.output?.find((item) => item.type === 'message')
  // Both call kinds land in the one chat `tool_calls` slot. Requests go
  // upstream with `parallel_tool_calls:false`, so at most one is expected;
  // the first is taken for the same reason it always was.
  const toolCallOutput = responseData.output?.find(
    (item) => item.type === 'function_call' || item.type === 'custom_tool_call'
  )
  const annotations = buildAnnotationsFromMessage(messageOutput)

  logger?.debug({
    data: annotations,
    type: 'url_citation'
  })

  const thinking = messageOutput?.reasoning ? { content: messageOutput.reasoning } : null
  const messageContent = buildMessageContentFromOutput(messageOutput)
  const isCustomCall = toolCallOutput?.type === 'custom_tool_call'
  const toolCalls = toolCallOutput
    ? [
        {
          id: firstDefined([toolCallOutput.call_id, toolCallOutput.id]),
          function: {
            name: toolCallOutput.name,
            // A custom call's payload is `input`; `arguments` is the
            // function kind's and is absent on one of these.
            arguments: isCustomCall ? toolCallOutput.input : toolCallOutput.arguments
          },
          type: isCustomCall ? 'custom' : 'function'
        }
      ]
    : null

  const usage = responseData.usage
    ? {
        prompt_tokens: responseData.usage.input_tokens,
        completion_tokens: responseData.usage.output_tokens,
        total_tokens: responseData.usage.total_tokens
      }
    : null

  return {
    id: newChatcmplId(responseData.id),
    object: 'chat.completion',
    created: responseData.created_at,
    model: responseData.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: messageContent,
          tool_calls: toolCalls,
          thinking,
          annotations
        },
        logprobs: null,
        finish_reason: toolCalls ? 'tool_calls' : 'stop'
      }
    ],
    usage
  }
}

function buildAnnotationsFromMessage(
  messageOutput: ResponsesAPIOutputItem | undefined
): Array<Record<string, unknown>> | undefined {
  const firstAnnotations = messageOutput?.content?.[0]?.annotations
  if (!firstAnnotations || firstAnnotations.length === 0) return undefined
  // ResponsesAnnotationSchema fills missing fields with defaults
  // (`''`/0), so each item is read directly here.
  return firstAnnotations.map((item) => ({
    type: 'url_citation',
    url_citation: {
      url: item.url,
      title: item.title,
      content: '',
      start_index: item.start_index,
      end_index: item.end_index
    }
  }))
}

function buildMessageContentFromOutput(
  messageOutput: ResponsesAPIOutputItem | undefined
): string | MessageContent[] | null {
  if (!messageOutput?.content) return null

  const textParts: string[] = []
  const imageParts: MessageContent[] = []

  messageOutput.content.forEach((item) => {
    collectContentItem(item, textParts, imageParts)
  })

  if (imageParts.length > 0) {
    const contentArray: MessageContent[] = []
    if (textParts.length > 0) {
      contentArray.push({
        type: 'text',
        text: textParts.join('')
      })
    }
    contentArray.push(...imageParts)
    return contentArray
  }

  const joined = textParts.join('')
  return joined === '' ? null : joined
}

function collectContentItem(item: ResponsesAPIOutputContent, textParts: string[], imageParts: MessageContent[]): void {
  if (item.type === 'output_text') {
    if (typeof item.text === 'string') textParts.push(item.text)
    return
  }
  if (item.type === 'output_image') {
    const imageContent = buildImageContent({
      url: item.image_url,
      mime_type: item.mime_type
    })
    if (imageContent) imageParts.push(imageContent)
    return
  }
  if (item.type === 'output_image_base64') {
    const imageContent = buildImageContent({
      b64_json: item.image_base64,
      mime_type: item.mime_type
    })
    if (imageContent) imageParts.push(imageContent)
  }
}

function buildImageContent(source: { url?: string; b64_json?: string; mime_type?: string }): MessageContent | null {
  if (!source.url && !source.b64_json) return null
  if (typeof source.mime_type !== 'string' || source.mime_type === '') return null

  const url = source.url
  if (typeof url !== 'string' || url === '') return null

  // The shared `ImageContent` schema only models a URL-form image_url;
  // the base64 fallback is a Responses-API extension we synthesise
  // here. When only b64_json is available, callers must encode it
  // into a data: URL upstream.
  const content: MessageContent = {
    type: 'image_url',
    image_url: { url },
    media_type: source.mime_type
  }
  return content
}
