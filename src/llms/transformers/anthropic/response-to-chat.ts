/**
 * Anthropic Messages API response → OpenAI Chat Completions envelope.
 *
 * The reverse of what `anthropic/response-blocking.ts` does (Chat →
 * Anthropic). Both Claude steps (`anthropic`, `claude-code-oauth`) run it on
 * the conversion path, so an OpenAI-compat caller whose request was routed
 * to Claude gets `{object:'chat.completion', choices:[{message,
 * finish_reason}], usage}` back instead of the raw Anthropic envelope, and
 * the surface's own endpoint converter can take it from there.
 *
 * The streaming counterpart is `./response-to-chat-stream.ts`; the two
 * agree on every field they emit — the same usage (`chatUsageOf`), the
 * same thinking field, the same finish reasons.
 *
 * Reads the upstream defensively: the content blocks an answer can carry
 * grow (server tool results, redacted thinking, …), and one this does not
 * know is skipped rather than failing a reply the client could still use.
 */

import { anthropicToOpenAiFinishReason } from '../../utils/finish-reason'
import { isObject } from '../../utils/guards'
import { nowSeconds } from '../../utils/time'

/**
 * Whether a body is an Anthropic message envelope. The `type: "message"`
 * marker and an array `content` are the strongest distinguishing signals;
 * Anthropic always emits both on a successful response, and neither Chat
 * nor Responses uses them at the top level — so anything else is passed on
 * untouched by the caller.
 */
export function isAnthropicMessageResponse(value: unknown): value is Record<string, unknown> {
  return isObject(value) && value.type === 'message' && Array.isArray(value.content)
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/**
 * Anthropic usage in Chat's vocabulary. Anthropic reports `input_tokens` as
 * the uncached remainder with the cache read and write beside it; Chat's
 * `prompt_tokens` is the whole prompt, with the read restated as
 * `prompt_tokens_details.cached_tokens` ("cached tokens present in the
 * prompt") — the inverse of `computeUsage` in `response-shared.ts`. The
 * request log is not built from this: it reads the raw upstream body.
 */
export function chatUsageOf(usage: Record<string, unknown>): Record<string, unknown> {
  const cached = count(usage.cache_read_input_tokens)
  const prompt = count(usage.input_tokens) + cached + count(usage.cache_creation_input_tokens)
  const completion = count(usage.output_tokens)
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached }
  }
}

const blocksOf = (content: unknown): Array<Record<string, unknown>> =>
  Array.isArray(content) ? content.filter(isObject) : []

function textOf(blocks: readonly Record<string, unknown>[]): string {
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('')
}

// OpenAI's `tool_calls[].function.arguments` is a JSON string; Anthropic's
// `tool_use.input` is the decoded object. Stringified back, the client
// parses it as it would an OpenAI reply. Server tool calls
// (`server_tool_use`) are Anthropic's to run and are not the client's.
function toolCallsOf(blocks: readonly Record<string, unknown>[]): Array<Record<string, unknown>> {
  return blocks
    .filter((block) => block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: block.input === undefined ? '{}' : JSON.stringify(block.input) }
    }))
}

// The chat-shaped pipeline's thinking field (`message.thinking`, as the
// Responses and Gemini converters write it): the text of the thinking
// blocks and the signature that closes the last of them. Thinking shown
// as omitted still has a signature, and still says thinking happened.
function thinkingOf(blocks: readonly Record<string, unknown>[]): Record<string, unknown> | undefined {
  const thinking = blocks.filter((block) => block.type === 'thinking')
  if (thinking.length === 0) return undefined
  const content = thinking.map((block) => (typeof block.thinking === 'string' ? block.thinking : '')).join('')
  const signatures = thinking.flatMap((block) =>
    typeof block.signature === 'string' && block.signature.length > 0 ? [block.signature] : []
  )
  const signature = signatures.at(-1)
  return signature === undefined ? { content } : { content, signature }
}

/**
 * Convert an Anthropic Messages API JSON response to the OpenAI Chat
 * Completions envelope. Callers guard with `isAnthropicMessageResponse`
 * first; every field read here is still read defensively.
 */
export function convertAnthropicResponseToChat(anthropic: Record<string, unknown>): Record<string, unknown> {
  const blocks = blocksOf(anthropic.content)
  const text = textOf(blocks)
  const toolCalls = toolCallsOf(blocks)
  const thinking = thinkingOf(blocks)

  // Chat's `content` is null when the assistant emitted tool_calls only.
  const message: Record<string, unknown> = { role: 'assistant', content: text.length > 0 ? text : null }
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  if (thinking !== undefined) message.thinking = thinking

  const envelope: Record<string, unknown> = {
    id: typeof anthropic.id === 'string' ? anthropic.id : `chatcmpl-${nowSeconds()}`,
    object: 'chat.completion',
    created: nowSeconds(),
    model: typeof anthropic.model === 'string' ? anthropic.model : '',
    choices: [
      {
        index: 0,
        message,
        finish_reason: anthropicToOpenAiFinishReason(
          typeof anthropic.stop_reason === 'string' ? anthropic.stop_reason : null
        )
      }
    ]
  }
  if (isObject(anthropic.usage)) envelope.usage = chatUsageOf(anthropic.usage)
  return envelope
}
