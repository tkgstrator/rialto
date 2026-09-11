/**
 * Anthropic inbound (wire -> unified) request conversion.
 *
 * Converts an already-Zod-parsed `AnthropicIncomingRequest` (messages,
 * system, tools, tool_choice, thinking) into unified `UnifiedMessage[]` /
 * `UnifiedTool[]` / `tool_choice` pieces for `transformRequestOut`.
 */

import { HTTPException } from 'hono/http-exception'
import type { MessageContent, UnifiedChatRequest, UnifiedMessage, UnifiedTool } from '@/schemas/domain/unified'
import {
  type AnthropicContentBlock,
  AnthropicContentBlockSchema,
  type AnthropicCustomToolDef,
  type AnthropicIncomingMessage,
  type AnthropicIncomingRequest,
  type AnthropicToolDef
} from '@/schemas/wire/anthropic/messages'
import { formatBase64 } from '../../utils/image'

export function buildSystemMessage(system: AnthropicIncomingRequest['system']): UnifiedMessage | undefined {
  if (!system) return undefined
  if (typeof system === 'string') {
    return { role: 'system', content: system }
  }
  if (!Array.isArray(system) || system.length === 0) return undefined
  const textParts = system
    .filter((item) => item.type === 'text' && typeof item.text === 'string' && item.text.length > 0)
    .map((item) => {
      if (item.text === undefined) {
        throw new HTTPException(500, { message: 'Anthropic system block missing text after filter' })
      }
      return {
        type: 'text' as const,
        text: item.text,
        cache_control: item.cache_control
      }
    })
  if (textParts.length === 0) return undefined
  return { role: 'system', content: textParts }
}

// One block of a tool_result's content array. Text and images are what
// Anthropic tools return; anything else keeps the JSON it was always
// forwarded as.
function toolResultParts(block: unknown): MessageContent[] {
  const parsed = AnthropicContentBlockSchema.safeParse(block)
  if (parsed.success && parsed.data.type === 'text' && parsed.data.text !== undefined) {
    return [{ type: 'text', text: parsed.data.text }]
  }
  if (parsed.success && parsed.data.type === 'image' && parsed.data.source !== undefined) {
    return [convertImagePart(parsed.data)]
  }
  return [{ type: 'text', text: JSON.stringify(block) }]
}

/**
 * A tool_result's content, as the unified tool message carries it.
 *
 * All-text content collapses to one string, which is what every outbound
 * conversion has always been handed. An image stays an image part. It
 * used to be serialised with the rest of the array, so a screenshot from
 * Read reached the upstream as a megabyte of base64 prompt text — past the
 * context window, and in every later turn of the same conversation (Codex
 * answers that with `response.failed` on a stream that already said 200).
 * Each outbound conversion renders the parts in its own wire format: the
 * Responses API takes `input_image` in a function output natively, and
 * `liftToolResultImages` moves them out for the formats that cannot.
 */
function toolResultContent(content: unknown): UnifiedMessage['content'] {
  if (typeof content === 'string') return content
  if (content === undefined || content === null) return '{}'
  if (!Array.isArray(content) || content.length === 0) return JSON.stringify(content)
  const parts = content.flatMap(toolResultParts)
  const texts = parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))
  return texts.length === parts.length ? texts.join('\n') : parts
}

function buildToolResultMessages(blocks: AnthropicContentBlock[]): UnifiedMessage[] {
  return blocks
    .filter((c) => c.type === 'tool_result' && c.tool_use_id)
    .map((tool) => ({
      role: 'tool' as const,
      content: toolResultContent(tool.content),
      tool_call_id: tool.tool_use_id,
      cache_control: tool.cache_control
    }))
}

// Convert one image content block to its unified `image_url` shape.
function convertImagePart(part: AnthropicContentBlock): {
  type: 'image_url'
  image_url: { url: string }
  media_type: string
} {
  if (!part.source) {
    throw new HTTPException(500, { message: 'Anthropic image block missing source' })
  }
  const src = part.source
  if (src.media_type === undefined) {
    throw new HTTPException(500, { message: 'Anthropic image block missing media_type' })
  }
  let url: string
  if (src.type === 'base64') {
    if (src.data === undefined) {
      throw new HTTPException(500, { message: 'Anthropic base64 image block missing data' })
    }
    url = formatBase64(src.data, src.media_type)
  } else {
    if (src.url === undefined) {
      throw new HTTPException(500, { message: 'Anthropic url image block missing url' })
    }
    url = src.url
  }
  return {
    type: 'image_url',
    image_url: { url },
    media_type: src.media_type
  }
}

function buildUserContent(blocks: AnthropicContentBlock[]): UnifiedMessage | undefined {
  const parts = blocks.filter((c) => (c.type === 'text' && c.text) || (c.type === 'image' && c.source))
  if (!parts.length) return undefined
  return {
    role: 'user',
    content: parts.map((part) => {
      if (part.type === 'image') return convertImagePart(part)
      if (part.text === undefined) {
        throw new HTTPException(500, { message: 'Anthropic text block missing text after filter' })
      }
      return { type: 'text' as const, text: part.text, cache_control: part.cache_control }
    })
  }
}

function buildAssistantTextContent(blocks: AnthropicContentBlock[]): string {
  const textParts = blocks.filter((c) => c.type === 'text' && c.text)
  if (textParts.length === 0) return ''
  return textParts
    .map((text) => {
      if (text.text === undefined) {
        throw new HTTPException(500, { message: 'Anthropic assistant text block missing text after filter' })
      }
      return text.text
    })
    .join('\n')
}

function buildAssistantToolCalls(blocks: AnthropicContentBlock[]): UnifiedMessage['tool_calls'] {
  const toolCallParts = blocks.filter((c) => c.type === 'tool_use' && c.id)
  if (toolCallParts.length === 0) return undefined
  return toolCallParts.map((tool) => {
    if (tool.id === undefined) {
      throw new HTTPException(500, { message: 'Anthropic tool_use block missing id after filter' })
    }
    if (tool.name === undefined) {
      throw new HTTPException(500, { message: 'Anthropic tool_use block missing name' })
    }
    // tool.input is genuinely optional in the Anthropic wire format;
    // empty object is the correct "no arguments" representation.
    const input = tool.input === undefined || tool.input === null ? {} : tool.input
    return {
      id: tool.id,
      type: 'function' as const,
      function: {
        name: tool.name,
        arguments: JSON.stringify(input)
      }
    }
  })
}

function buildAssistantThinking(blocks: AnthropicContentBlock[]): UnifiedMessage['thinking'] {
  const thinkingPart = blocks.find((c) => c.type === 'thinking' && c.signature && c.thinking)
  if (!thinkingPart) return undefined
  return {
    content: thinkingPart.thinking!,
    signature: thinkingPart.signature
  }
}

function buildAssistantMessage(blocks: AnthropicContentBlock[]): UnifiedMessage {
  const assistantMessage: UnifiedMessage = {
    role: 'assistant',
    content: buildAssistantTextContent(blocks)
  }
  const toolCalls = buildAssistantToolCalls(blocks)
  if (toolCalls) assistantMessage.tool_calls = toolCalls
  const thinking = buildAssistantThinking(blocks)
  if (thinking) assistantMessage.thinking = thinking
  return assistantMessage
}

export function appendIncomingMessage(messages: UnifiedMessage[], msg: AnthropicIncomingMessage): void {
  if (msg.role !== 'user' && msg.role !== 'assistant') return

  if (typeof msg.content === 'string') {
    messages.push({ role: msg.role, content: msg.content })
    return
  }

  if (!Array.isArray(msg.content)) return

  if (msg.role === 'user') {
    messages.push(...buildToolResultMessages(msg.content))
    const userMessage = buildUserContent(msg.content)
    if (userMessage) messages.push(userMessage)
  } else {
    messages.push(buildAssistantMessage(msg.content))
  }
}

export function buildToolChoice(
  toolChoice: AnthropicIncomingRequest['tool_choice']
): UnifiedChatRequest['tool_choice'] {
  if (!toolChoice) return undefined
  if (toolChoice.type === 'tool') {
    // Discriminated union guarantees `name` here — see AnthropicToolChoiceSchema.
    return {
      type: 'function',
      function: { name: toolChoice.name }
    }
  }
  return toolChoice.type
}

export function convertAnthropicToolsToUnified(tools: AnthropicToolDef[]): UnifiedTool[] {
  return tools.map((tool) => {
    // Server-side tools (`web_search_*`, `computer_*`, `bash_*`,
    // `text_editor_*`, `code_execution_*`) carry only `type` + `name` on
    // the wire — no description / input_schema. Represent them as a
    // unified function tool keyed by `name` so downstream provider
    // transformers (e.g. openai-responses/remapTools) can detect and
    // remap them; fall back to `name` for description and empty object
    // params to satisfy the unified schema.
    if (!isCustomTool(tool)) {
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.name,
          parameters: { type: 'object', properties: {} }
        },
        cache_control: tool.cache_control
      }
    }
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema
      },
      cache_control: tool.cache_control
    }
  })
}

function isCustomTool(tool: AnthropicToolDef): tool is AnthropicCustomToolDef {
  return 'input_schema' in tool
}
