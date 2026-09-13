/**
 * OpenAI Responses request-shaping helpers.
 *
 * Pure functions that reshape a UnifiedChatRequest (already widened to
 * ResponsesUnifiedChatRequest by the caller) into the Responses API's
 * input/instructions/tools wire shape.
 */

import { isUnifiedFunctionTool, type UnifiedChatRequest } from '@/schemas/domain/unified'
import type { ResponsesUnifiedChatRequest } from '@/schemas/wire/openai/responses'
import { isObject } from '../../../utils/guards'

type MutableMessage = Record<string, unknown>

type RequestContentBlock = {
  type?: string
  text?: string
  image_url?: { url?: string }
  cache_control?: unknown
}

function isTextWrapper(value: unknown): value is { text: string } {
  return isObject(value) && typeof value.text === 'string'
}

function isRequestContentBlock(value: unknown): value is RequestContentBlock {
  return isObject(value)
}

function setField(target: MutableMessage, key: string, value: unknown): void {
  target[key] = value
}

function deleteField(target: MutableMessage, key: string): void {
  delete target[key]
}

export function rewriteReasoning(responsesReq: ResponsesUnifiedChatRequest): void {
  if (!responsesReq.reasoning) return
  const effort = responsesReq.reasoning.effort
  // biome-ignore plugin: rewriting `reasoning` to the Responses-API `{effort, summary}` shape — the unified type narrows it as `{effort, max_tokens, enabled}` only.
  ;(responsesReq as unknown as { reasoning: Record<string, unknown> }).reasoning = {
    effort,
    summary: 'detailed'
  }
}

export function collectSystemMessages(responsesReq: ResponsesUnifiedChatRequest, input: unknown[]): void {
  // Defensive against a body that reached this transformer with no
  // `messages` field — an OpenAI-compat caller sending
  // `POST /v1/chat/completions {model}` used to crash the whole
  // request with an internal 500 (`undefined is not an object
  // (evaluating 'responsesReq.messages.filter')`) that leaked the
  // internal expression name. The route-plan validator ahead of us
  // should reject that request with 400, but the transformer must not
  // depend on it — treat "no messages" as "no system messages" here.
  const messages = Array.isArray(responsesReq.messages) ? responsesReq.messages : []
  const systemMessages = messages.filter((msg) => msg.role === 'system')
  if (systemMessages.length === 0) return

  const firstSystem = systemMessages[0]
  if (Array.isArray(firstSystem.content)) {
    firstSystem.content.forEach((item) => {
      let text = ''
      if (typeof item === 'string') {
        text = item
      } else if (isTextWrapper(item)) {
        text = item.text
      }
      input.push({ role: 'system', content: text })
    })
  } else {
    responsesReq.instructions = typeof firstSystem.content === 'string' ? firstSystem.content : undefined
  }
}

function normalizeRequestContent(
  content: RequestContentBlock,
  role: string | undefined
): Record<string, unknown> | null {
  const clone: Record<string, unknown> = { ...content }
  delete clone.cache_control

  if (content.type === 'text') {
    return {
      type: role === 'assistant' ? 'output_text' : 'input_text',
      text: content.text
    }
  }

  if (content.type === 'image_url') {
    const imagePayload: Record<string, unknown> = {
      type: role === 'assistant' ? 'output_image' : 'input_image'
    }

    if (typeof content.image_url?.url === 'string') {
      imagePayload.image_url = content.image_url.url
    }

    return imagePayload
  }

  return null
}

export function processNonSystemMessage(message: UnifiedChatRequest['messages'][number], input: unknown[]): void {
  // The message is already an object — narrow it for mutation without `as`.
  if (!isObject(message)) return
  const mutable: MutableMessage = message

  if (Array.isArray(message.content)) {
    const convertedContent = message.content
      .map((content) => (isRequestContentBlock(content) ? normalizeRequestContent(content, message.role) : null))
      .filter((content): content is Record<string, unknown> => content !== null)

    if (convertedContent.length > 0) {
      setField(mutable, 'content', convertedContent)
    } else {
      deleteField(mutable, 'content')
    }
  }

  if (message.role === 'tool') {
    const toolMessage: MutableMessage = { ...mutable }
    toolMessage.type = 'function_call_output'
    toolMessage.call_id = message.tool_call_id
    toolMessage.output = message.content
    deleteField(toolMessage, 'cache_control')
    deleteField(toolMessage, 'role')
    deleteField(toolMessage, 'tool_call_id')
    deleteField(toolMessage, 'content')
    input.push(toolMessage)
    return
  }

  if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((tool) => {
      input.push({
        type: 'function_call',
        arguments: tool.function.arguments,
        name: tool.function.name,
        call_id: tool.id
      })
    })
    return
  }

  // The Responses API strictly validates every `input[]` item and
  // rejects unknown fields with 400 "Unknown parameter:
  // 'input[N].thinking'". An Anthropic-format assistant turn that
  // came through the passthrough path still carries `thinking`
  // (extended-reasoning block) and a message-level `cache_control`,
  // neither of which the Responses schema accepts. Strip them
  // before the raw message reaches the input array — the reasoning
  // is replayed separately via the top-level `reasoning` param.
  deleteField(mutable, 'thinking')
  deleteField(mutable, 'cache_control')

  input.push(message)
}

// Reshape `tool_choice` from the unified Chat-Completions form to the
// flat Responses-API form. Mirrors `remapTools`:
//   - string literals ('auto' / 'none' / 'required') pass through verbatim
//   - `{type:'function', function:{name}}` -> `{type:'function', name}`
//     (the OpenAI-Responses schema expects `name` at the top level; a
//     nested `function.name` triggers a 400
//     "Missing required parameter: 'tool_choice.name'")
//   - a `web_search` target collapses to the hosted-tool shape
//     `{type:'web_search'}`, matching how remapTools emits the tool itself
//   - unknown shapes pass through so the upstream surfaces the mismatch
//     directly instead of being silently masked here
export function remapToolChoice(choice: UnifiedChatRequest['tool_choice']): unknown {
  if (choice === undefined) return undefined
  if (typeof choice === 'string') return choice
  if (choice.type !== 'function') return choice
  const name = choice.function.name
  if (name === 'web_search') return { type: 'web_search' }
  return { type: 'function', name }
}

// Convert Chat-Completions `response_format` to the Responses-API
// `text.format` shape. The three canonical Chat shapes:
//
//   {type: 'text'}
//   {type: 'json_object'}
//   {type: 'json_schema', json_schema: {name, schema, strict?, description?}}
//
// map to the flatter Responses shape:
//
//   {type: 'text'}
//   {type: 'json_object'}
//   {type: 'json_schema', name, schema, strict?, description?}
//
// Returns null for shapes we can't confidently translate so the caller
// can drop the field rather than build a malformed request.
export function convertResponseFormatToTextFormat(raw: unknown): unknown {
  if (!isObject(raw)) return null
  const type = raw.type
  if (type === 'text' || type === 'json_object') return { type }
  if (type !== 'json_schema') return null
  const jsonSchema = raw.json_schema
  if (!isObject(jsonSchema)) return null
  const flat: Record<string, unknown> = { type: 'json_schema' }
  if (typeof jsonSchema.name === 'string') flat.name = jsonSchema.name
  if (isObject(jsonSchema.schema)) flat.schema = jsonSchema.schema
  if (typeof jsonSchema.strict === 'boolean') flat.strict = jsonSchema.strict
  if (typeof jsonSchema.description === 'string') flat.description = jsonSchema.description
  return flat
}

export function remapTools(tools: UnifiedChatRequest['tools']): unknown[] {
  if (!Array.isArray(tools)) return []
  const hasWebSearch = tools.some((tool) => isUnifiedFunctionTool(tool) && tool.function.name === 'web_search')

  const remapped: unknown[] = tools.flatMap((tool) => {
    // A tool carrying no `function` object — Codex's `namespace`, and
    // `custom` / `local_shell` elsewhere. Responses is the wire format on
    // both sides of this transformer, so the caller already wrote the
    // shape the upstream wants: emit it verbatim. Reading
    // `tool.function.name` on one of these answered every Codex request
    // that offered a tool with a 500.
    if (!isUnifiedFunctionTool(tool)) return [tool]
    if (tool.function.name === 'web_search') return []
    if (tool.function.name === 'WebSearch') {
      const properties = tool.function.parameters.properties
      if (isObject(properties)) {
        delete properties.allowed_domains
      }
    }
    if (tool.function.name === 'Edit') {
      return [
        {
          type: tool.type,
          name: tool.function.name,
          description: tool.function.description,
          parameters: {
            ...tool.function.parameters,
            required: ['file_path', 'old_string', 'new_string', 'replace_all']
          },
          strict: true
        }
      ]
    }
    return [
      {
        type: tool.type,
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters
      }
    ]
  })

  if (hasWebSearch) {
    remapped.push({ type: 'web_search' })
  }

  return remapped
}
