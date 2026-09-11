/**
 * Images out of tool messages, for the wire formats whose tool role
 * cannot carry one.
 *
 * A unified tool message keeps a tool's image output as image parts (see
 * `toolResultContent` in the Anthropic request conversion), because the
 * Responses API takes `input_image` inside a function output and loses
 * nothing. Chat Completions accepts only text on a `tool` message — an
 * image part there is a 400 — and Gemini's `functionResponse.response` is
 * a JSON value, so a data URL inside it is read as prompt text. Those two
 * run their messages through here first.
 */

import type { ImageContent, MessageContent, TextContent, UnifiedMessage } from '@/schemas/domain/unified'

// Where a tool message's image went. Without it the model reads a tool
// that returned nothing, followed by an image from nowhere.
export const LIFTED_IMAGE_NOTE = '[The image output of this tool call is attached in the next message.]'

const isImage = (part: MessageContent): part is ImageContent => part.type === 'image_url'
const isText = (part: MessageContent): part is TextContent => part.type === 'text'

/**
 * Tool messages reduced to text, and their images moved into one user
 * message after the run of tool messages they came from.
 *
 * After the run, not after each: Chat requires every tool message that
 * answers an assistant turn to follow it directly, so nothing may be
 * inserted between two of them. Messages without an image part are
 * returned as they came.
 */
export function liftToolResultImages(messages: readonly UnifiedMessage[]): UnifiedMessage[] {
  const out: UnifiedMessage[] = []
  const lifted: ImageContent[] = []
  const flush = (): void => {
    if (lifted.length > 0) out.push({ role: 'user', content: lifted.splice(0) })
  }
  for (const message of messages) {
    if (message.role !== 'tool') flush()
    const content = message.content
    if (message.role !== 'tool' || !Array.isArray(content) || !content.some(isImage)) {
      out.push(message)
      continue
    }
    lifted.push(...content.filter(isImage))
    const text = content
      .filter(isText)
      .map((part) => part.text)
      .join('\n')
    out.push({ ...message, content: text.length > 0 ? `${text}\n${LIFTED_IMAGE_NOTE}` : LIFTED_IMAGE_NOTE })
  }
  flush()
  return out
}
