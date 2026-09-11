/**
 * Gemini request shaping: `contents[]` (the message list).
 *
 * Split out of `gemini-request.ts` — this half converts unified messages
 * into Gemini `Content` entries, including image parts and tool-call /
 * tool-response pairing. `request-config.ts` builds the sibling
 * `generationConfig` / `toolConfig` / `tools[]` blocks.
 */

import { HTTPException } from 'hono/http-exception'
import type { MessageContent, UnifiedMessage } from '@/schemas/domain/unified'
import type {
  GeminiContent,
  GeminiFunctionCallPart,
  GeminiFunctionResponsePart,
  GeminiPart,
  GeminiTextPart
} from '@/schemas/wire/gemini/content'
import { liftToolResultImages } from '../tool-result-images'

const genRandomToolId = (): string => `tool_${Math.random().toString(36).substring(2, 15)}`

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Parse a `tool_calls[].function.arguments` JSON string into the
 * arg-record shape Gemini expects. Falls back to an empty record on
 * an empty / missing payload; throws an HTTPException if the JSON
 * parses but isn't object-shaped.
 */
function parseToolArguments(rawArgs: string | undefined): Record<string, unknown> {
  const source = rawArgs && rawArgs.length > 0 ? rawArgs : '{}'
  const parsed: unknown = JSON.parse(source)
  if (!isPlainRecord(parsed)) {
    throw new HTTPException(500, {
      message: `Invalid Gemini tool-call arguments JSON: expected object, got ${typeof parsed}`
    })
  }
  return parsed
}

/**
 * Map the unified message role onto the Gemini role enum.
 * Anything other than `assistant` collapses to `'user'` to mirror the
 * legacy contract.
 */
function geminiRoleOf(message: UnifiedMessage): 'user' | 'model' {
  return message.role === 'assistant' ? 'model' : 'user'
}

/**
 * Build parts[] from a string-valued message body, attaching the
 * thoughtSignature when present.
 */
function buildStringContentParts(content: string, message: UnifiedMessage): GeminiPart[] {
  const part: GeminiTextPart = { text: content }
  if (message?.thinking?.signature) {
    part.thoughtSignature = message.thinking.signature
  }
  return [part]
}

/** Build parts[] from a structured array message body. */
function buildArrayContentParts(content: MessageContent[]): GeminiPart[] {
  const parts: GeminiPart[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ text: block.text })
      continue
    }
    if (block.type === 'image_url') {
      parts.push(buildImagePart(block.image_url.url, block.media_type))
    }
  }
  return parts
}

/**
 * Defensive fallback branch for object-shaped message content. The
 * unified type does not allow it, but the vendor implementation
 * accepted `{ text: "..." }` objects so we keep the behaviour and
 * stringify anything else.
 */
function buildObjectContentParts(content: object): GeminiPart[] {
  const obj: Record<string, unknown> = { ...content }
  if (typeof obj.text === 'string') {
    return [{ text: obj.text }]
  }
  return [{ text: JSON.stringify(content) }]
}

/**
 * Build the `parts[]` for a single non-tool message. Splits the parts
 * dispatch (string vs. array vs. defensive object) so the caller stays
 * readable.
 */
function buildMessageParts(message: UnifiedMessage): GeminiPart[] {
  if (typeof message.content === 'string') {
    return buildStringContentParts(message.content, message)
  }
  if (Array.isArray(message.content)) {
    return buildArrayContentParts(message.content)
  }
  if (message.content && typeof message.content === 'object') {
    return buildObjectContentParts(message.content)
  }
  return []
}

/**
 * Build an image part — either remote `file_data` for HTTP URLs or
 * inline base64 `inlineData` for data URLs.
 */
function buildImagePart(url: string, mediaType: string): GeminiPart {
  if (url.startsWith('http')) {
    return { file_data: { mime_type: mediaType, file_uri: url } }
  }
  // data: URIs come through as `data:<mime>;base64,<payload>` — take the
  // payload after the comma. Fall back to the original URL string when
  // there is no comma, mirroring the legacy behaviour.
  const commaIndex = url.indexOf(',')
  const data = commaIndex >= 0 ? url.slice(commaIndex + 1) : url
  return { inlineData: { mime_type: mediaType, data } }
}

/**
 * Append `functionCall` parts derived from the assistant message's
 * `tool_calls` (if any). The first call carries the thoughtSignature
 * so Gemini can reconstruct the reasoning chain.
 */
function appendToolCallParts(parts: GeminiPart[], message: UnifiedMessage): void {
  if (!Array.isArray(message.tool_calls)) {
    return
  }
  message.tool_calls.forEach((toolCall, index) => {
    const part: GeminiFunctionCallPart = {
      functionCall: {
        id: toolCall.id || genRandomToolId(),
        name: toolCall.function.name,
        args: parseToolArguments(toolCall.function.arguments)
      }
    }
    if (index === 0 && message.thinking?.signature) {
      part.thoughtSignature = message.thinking.signature
    }
    parts.push(part)
  })
}

/**
 * Build the `parts[]` slice that carries tool *responses* to be sent
 * after an assistant tool-call turn.
 */
function buildToolResponseParts(
  message: UnifiedMessage,
  toolResponses: UnifiedMessage[]
): GeminiFunctionResponsePart[] | null {
  if (!message.tool_calls) {
    return null
  }
  return message.tool_calls.map((tool) => {
    const response = toolResponses.find((item) => item.tool_call_id === tool.id)
    return {
      functionResponse: {
        name: tool?.function?.name,
        response: { result: response?.content }
      }
    }
  })
}

/**
 * Build the `contents[]` slice. Skips tool-role messages (their
 * payloads are paired against the preceding assistant tool call) and
 * appends a synthetic `user` turn carrying tool responses after each
 * assistant tool-call turn.
 */
export function buildContents(unified: UnifiedMessage[]): GeminiContent[] {
  // A functionResponse result is a JSON value, not parts, so a tool's
  // image has to travel as an ordinary user turn beside it.
  const messages = liftToolResultImages(unified)
  const contents: GeminiContent[] = []
  const toolResponses = messages.filter((item) => item.role === 'tool')
  for (const message of messages) {
    if (message.role === 'tool') {
      continue
    }
    const role = geminiRoleOf(message)
    const parts: GeminiPart[] = buildMessageParts(message)
    appendToolCallParts(parts, message)
    if (parts.length === 0) {
      parts.push({ text: '' })
    }
    contents.push({ role, parts })

    if (role === 'model') {
      const responseParts = buildToolResponseParts(message, toolResponses)
      if (responseParts) {
        contents.push({ role: 'user', parts: responseParts })
      }
    }
  }
  return contents
}
