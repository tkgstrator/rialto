/**
 * Anthropic endpoint transformer.
 *
 * Owns `/v1/messages`. Converts Anthropic's wire format (messages,
 * system, tools, tool_choice, thinking blocks) into the unified shape on
 * the way in, and converts an OpenAI-shaped response (JSON or streaming)
 * back into Anthropic events on the way out so the Claude Code client
 * sees its native protocol.
 *
 * The conversion pieces live alongside this file:
 *   - `request.ts`            wire -> unified request conversion
 *   - `response-blocking.ts`  OpenAI ChatCompletion -> Anthropic message
 *   - `response-stream/`      OpenAI SSE -> Anthropic SSE (pump/dispatch/
 *                             tool-calls/state, see that folder's files)
 *   - `response-shared.ts`    helpers shared by both response directions
 */

import { HTTPException } from 'hono/http-exception'
import type { RuntimeProvider, TransformerContext, UnifiedChatRequest, UnifiedMessage } from '@/schemas/domain'
import { AnthropicIncomingRequestSchema } from '@/schemas/wire/anthropic/messages'
import { hasSafeguards } from '../../pipeline/classifier-diagnostics'
import { getThinkLevel } from '../../utils/thinking'
import { Transformer, type TransformerAuthResult } from '../base'
import { appendIncomingMessage, buildSystemMessage, buildToolChoice, convertAnthropicToolsToUnified } from './request'
import { convertOpenAIResponseToAnthropic } from './response-blocking'
import { runStreamPump } from './response-stream/pump'
import { createStreamState } from './response-stream/state'

type AnthropicTransformerOptions = {
  UseBearer?: boolean
}

// Read `context.req.id` defensively. `TransformerContext` allows
// arbitrary keys, so we narrow via the `in` operator (which is the
// canonical structural narrowing for unknown-shaped objects).
function getReqId(context: TransformerContext): string | undefined {
  const req = context.req
  if (req === undefined || req === null || typeof req !== 'object') return undefined
  if (!('id' in req)) return undefined
  const { id } = req
  return typeof id === 'string' ? id : undefined
}

export class AnthropicTransformer extends Transformer {
  readonly name = 'anthropic'
  readonly endPoint = '/v1/messages'
  private readonly useBearer: boolean

  constructor(options?: AnthropicTransformerOptions) {
    super()
    this.useBearer = options?.UseBearer === true
  }

  async auth(
    request: unknown,
    provider: RuntimeProvider,
    _context: TransformerContext
  ): Promise<TransformerAuthResult> {
    const headers: Record<string, string | undefined> = {}

    if (this.useBearer) {
      headers.authorization = `Bearer ${provider.api_key}`
      headers['x-api-key'] = undefined
    } else {
      headers['x-api-key'] = provider.api_key
      headers.authorization = undefined
    }

    return {
      body: request,
      config: { headers }
    }
  }

  async transformRequestOut(request: unknown, _context: TransformerContext): Promise<UnifiedChatRequest> {
    // Native Messages bypasses this hook. Internal callers that skip route
    // planning must also fail closed rather than discard this safety field.
    if (hasSafeguards(request)) {
      throw new HTTPException(400, {
        message: 'Anthropic safeguards cannot be converted to another provider; use a native Messages route.'
      })
    }
    const result = AnthropicIncomingRequestSchema.safeParse(request)
    if (!result.success) {
      throw new HTTPException(500, {
        message: `Invalid Anthropic request payload: ${result.error.message}`
      })
    }
    const req = result.data
    const messages: UnifiedMessage[] = []

    const systemMessage = buildSystemMessage(req.system)
    if (systemMessage) messages.push(systemMessage)

    // Deep clone so downstream consumers cannot mutate the parsed input.
    const requestMessages: typeof req.messages = JSON.parse(JSON.stringify(req.messages))
    for (const msg of requestMessages) {
      appendIncomingMessage(messages, msg)
    }

    // Checked after conversion, not before: a tool list holding only the
    // advisor converts to nothing, and OpenAI rejects an empty `tools`.
    const tools = convertAnthropicToolsToUnified(req.tools)
    const unified: UnifiedChatRequest = {
      messages,
      model: req.model,
      max_tokens: req.max_tokens,
      temperature: req.temperature,
      stream: req.stream,
      tools: tools.length ? tools : undefined,
      tool_choice: buildToolChoice(req.tool_choice)
    }

    // The modern field wins when both SDK spellings are present, including
    // explicit null (no format). Never rewrite the supplied JSON Schema.
    const format = req.output_config?.format === undefined ? req.output_format : req.output_config.format
    if (format !== undefined && format !== null) {
      unified.response_format = {
        type: 'json_schema',
        json_schema: { name: 'anthropic_output', schema: format.schema, strict: true }
      }
    }

    if (req.thinking?.type === 'enabled') {
      const budget = req.thinking.budget_tokens
      if (budget === undefined) {
        throw new HTTPException(500, { message: 'Anthropic thinking block missing budget_tokens' })
      }
      unified.reasoning = {
        effort: getThinkLevel(budget),
        enabled: true
      }
    }

    return unified
  }

  async transformResponseIn(response: Response, context?: TransformerContext): Promise<Response> {
    if (context === undefined) {
      throw new HTTPException(500, { message: 'AnthropicTransformer.transformResponseIn requires a context' })
    }
    const isStream = response.headers.get('Content-Type')?.includes('text/event-stream')
    if (isStream) {
      if (!response.body) {
        throw new Error('Stream response body is null')
      }
      const convertedStream = await this.convertOpenAIStreamToAnthropic(response.body, context)
      return new Response(convertedStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        }
      })
    }
    // The upstream provider returns a payload matching the OpenAI SDK's
    // `ChatCompletion` shape verbatim. We accept it as `unknown` and let
    // `convertOpenAIResponseToAnthropic` validate the fields it touches.
    const data: unknown = await response.json()
    const reqId = getReqId(context)
    const anthropicResponse = convertOpenAIResponseToAnthropic(data, reqId, this.logger)
    return new Response(JSON.stringify(anthropicResponse), {
      headers: { 'Content-Type': 'application/json' }
    })
  }

  private async convertOpenAIStreamToAnthropic(
    openaiStream: ReadableStream<Uint8Array>,
    context: TransformerContext
  ): Promise<ReadableStream<Uint8Array>> {
    const logger = this.logger
    const reqId = getReqId(context)

    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const state = createStreamState(controller, logger, reqId)
        runStreamPump(openaiStream, state, logger, reqId).catch((error) => {
          if (!state.isClosed) {
            try {
              controller.error(error)
            } catch (controllerError) {
              console.error(controllerError)
            }
          }
        })
      },
      cancel: (reason) => {
        logger?.debug({ reqId }, `cancle stream: ${String(reason)}`)
      }
    })

    return readable
  }
}
