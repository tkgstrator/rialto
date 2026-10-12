/**
 * Anthropic endpoint transformer.
 *
 * Owns `/v1/messages`. Converts Anthropic's wire format (messages,
 * system, tools, tool_choice, thinking blocks) into the unified shape on
 * the way in, and converts an OpenAI-shaped response (JSON or streaming)
 * back into Anthropic events on the way out so the Claude Code client
 * sees its native protocol.
 *
 * It is also the provider step of an Anthropic API-key provider. A
 * `/v1/messages` caller there takes the bypass path and only `auth()`
 * runs; any other caller — an OpenAI or Gemini surface routed to Claude —
 * runs `transformRequestIn` (unified → Anthropic Messages) and
 * `transformResponseOut` (Anthropic → Chat), the same conversion the
 * subscription step runs.
 *
 * The conversion pieces live alongside this file:
 *   - `request.ts`               wire -> unified request conversion
 *   - `request-from-unified.ts`  unified -> wire, for the provider step
 *   - `response-blocking.ts`     OpenAI ChatCompletion -> Anthropic message
 *   - `response-stream/`         OpenAI SSE -> Anthropic SSE (pump/dispatch/
 *                                tool-calls/state, see that folder's files)
 *   - `response-to-chat*.ts`     Anthropic -> OpenAI, for the provider step
 *   - `response-shared.ts`       helpers shared by both response directions
 */

import { HTTPException } from 'hono/http-exception'
import type {
  RuntimeProvider,
  TransformerContext,
  TransformerHookResult,
  UnifiedChatRequest,
  UnifiedMessage
} from '@/schemas/domain'
import { isProviderModelBlock } from '@/schemas/domain/pipeline'
import { AnthropicIncomingRequestSchema } from '@/schemas/wire/anthropic/messages'
import { hasSafeguards } from '../../pipeline/classifier-diagnostics'
import { getThinkLevel } from '../../utils/thinking'
import { Transformer, type TransformerAuthResult } from '../base'
import { appendIncomingMessage, buildSystemMessage, buildToolChoice, convertAnthropicToolsToUnified } from './request'
import { convertUnifiedToAnthropic } from './request-from-unified'
import { convertOpenAIResponseToAnthropic } from './response-blocking'
import { runStreamPump } from './response-stream/pump'
import { createStreamState } from './response-stream/state'
import { convertAnthropicReplyToChat } from './response-to-chat-stream'

// The version header a native caller sends itself; on the conversion path
// no client header is forwarded, so the step has to state it.
const ANTHROPIC_VERSION = '2023-06-01'

// A model whose `Model.apiStyle` differs from the provider's has its own
// conversion step after this one (`modelTransformerChains`), and the body
// has to reach that step still unified.
function hasOwnModelChain(provider: RuntimeProvider, model: string): boolean {
  const block: unknown = provider.transformer?.[model]
  return isProviderModelBlock(block) && Array.isArray(block.use) && block.use.length > 0
}

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

  /**
   * Provider step on the conversion path: the unified body to Anthropic
   * Messages, with the API key and version headers a native caller would
   * have sent.
   */
  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: RuntimeProvider,
    context: TransformerContext
  ): Promise<TransformerHookResult | UnifiedChatRequest> {
    if (hasOwnModelChain(provider, request.model)) return request
    const body = convertUnifiedToAnthropic(request, provider, context)
    const auth = await this.auth(body, provider, context)
    const headers = auth.config?.headers === undefined ? {} : auth.config.headers
    // `sendToProvider` seeds every request with `Authorization: Bearer
    // <api_key>`, and `auth()` unsets only the lowercase spelling — a
    // different key until the headers are built. Unset the seeded one too,
    // so the key goes as `x-api-key` alone (or as the bearer `auth()`
    // writes when the provider asks for one).
    return {
      body,
      config: { headers: { Authorization: undefined, ...headers, 'anthropic-version': ANTHROPIC_VERSION } }
    }
  }

  // The reply to a converted request, back in Chat shape. A body that is
  // not Anthropic's (a model with its own chain) is passed on untouched.
  async transformResponseOut(response: Response, _context: TransformerContext): Promise<Response> {
    return convertAnthropicReplyToChat(response, this.logger)
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
