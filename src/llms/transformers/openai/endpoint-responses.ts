/**
 * OpenAI Responses-API endpoint transformer.
 *
 * Owns `/v1/responses`. Reshapes the unified request into the Responses
 * input/instructions/tools shape and converts the Responses-style
 * (streaming or JSON) reply back into the chat-completions shape the
 * rest of the pipeline expects.
 *
 * The conversion pieces live under `./responses/`:
 *   - `request.ts`         unified request -> Responses input[] shaping
 *   - `response-json.ts`   blocking JSON response -> chat.completion
 *   - `response-stream.ts` SSE session (dispatches into `stream-chunks.ts`)
 *   - `stream-chunks.ts`   per-event-type SSE chunk builders
 *   - `helpers.ts`         small stateless helpers shared by the above
 */

import { HTTPException } from 'hono/http-exception'
import type { RuntimeProvider, TransformerContext, TransformerHookResult, UnifiedChatRequest } from '@/schemas/domain'
import {
  ChatCompletionResponseSchema,
  type ResponsesAPIPayload,
  ResponsesAPIPayloadSchema,
  type ResponsesStreamItem,
  type ResponsesUnifiedChatRequest
} from '@/schemas/wire'
import { cloneResponse } from '../../utils/response-clone'
import { aggregateOpenAiChatSseToJson, isSseContentType } from '../../utils/sse-aggregate'
import { Transformer } from '../base'
import {
  convertChatCompletionToResponses,
  convertResponsesRequestToUnified,
  wrapResponsesEnvelopeAsSse
} from './responses/inbound'
import {
  collectSystemMessages,
  convertResponseFormatToTextFormat,
  processNonSystemMessage,
  remapToolChoice,
  remapTools,
  rewriteReasoning
} from './responses/request'
import { convertResponseToChat } from './responses/response-json'
import { ResponsesStreamSession } from './responses/response-stream'

export class OpenAIResponsesTransformer extends Transformer {
  readonly name = 'openai-responses'
  readonly endPoint = '/v1/responses'

  // Endpoint-side inbound hook. Runs once per request BEFORE any
  // provider transformer chain — takes the /v1/responses wire body
  // (input/instructions/tools) and returns a UnifiedChatRequest so
  // scenario routing, `messages`-shaped token counting, and every
  // downstream provider transformer see a consistent shape. Round-trips
  // cleanly when the target provider chain ALSO includes openai-responses
  // (e.g. codex-oauth) — the provider chain's transformRequestIn
  // re-converts unified messages back to Responses shape.
  async transformRequestOut(request: unknown, _context: TransformerContext): Promise<UnifiedChatRequest> {
    if (request === null || typeof request !== 'object') return request as UnifiedChatRequest
    return convertResponsesRequestToUnified(request as Record<string, unknown>)
  }

  // Endpoint-side outbound hook. After the provider chain reversed the
  // upstream reply into unified/chat-completion shape, convert back to
  // the Responses `response` envelope the client asked for. SSE input is
  // buffered — real per-token streaming through the Chat→Responses
  // boundary is future work; for now the wire contract is honoured but
  // TTFT is lost.
  async transformResponseIn(response: Response, _context?: TransformerContext): Promise<Response> {
    if (!response.ok) return response
    const contentType = response.headers.get('content-type')
    if (isSseContentType(contentType)) {
      const chatJsonRaw = await aggregateOpenAiChatSseToJson(response)
      const chat = ChatCompletionResponseSchema.safeParse(chatJsonRaw)
      if (!chat.success) return response
      const envelope = convertChatCompletionToResponses(chat.data)
      const sse = wrapResponsesEnvelopeAsSse(envelope)
      return cloneResponse(response, sse, { 'content-type': 'text/event-stream' })
    }
    const text = await response.text()
    if (text.length === 0) return response
    const parsedJson = JSON.parse(text)
    const chat = ChatCompletionResponseSchema.safeParse(parsedJson)
    if (!chat.success) return response
    const envelope = convertChatCompletionToResponses(chat.data)
    return cloneResponse(response, JSON.stringify(envelope))
  }

  async transformRequestIn(
    request: UnifiedChatRequest,
    provider?: RuntimeProvider
  ): Promise<TransformerHookResult | UnifiedChatRequest> {
    // biome-ignore plugin: structural widening — Responses augments UnifiedChatRequest with optional fields (instructions/input/parallel_tool_calls) that we mutate in-place; the unified schema cannot model these without breaking other transformers.
    const responsesReq = request as ResponsesUnifiedChatRequest
    delete responsesReq.temperature

    // Rename the output ceiling rather than dropping it. The unified body
    // spells it `max_tokens`; an earlier chain step (OpenAITransformer)
    // may already have renamed it to `max_completion_tokens` for a
    // gpt-5.x model. The Responses API accepts neither — it wants
    // `max_output_tokens` — so both are read here and re-emitted under
    // that name.
    //
    // Measured against api.openai.com/v1/responses: the field is valid
    // and honoured at any value >= 16, and 400s below that
    // ("integer_below_min_value"). We forward whatever the caller asked
    // for, including a too-small value, because that is what a direct
    // call would do — a gateway that silently discards the ceiling bills
    // its caller for output they explicitly capped.
    //
    // A tight cap on a reasoning model can come back `incomplete` with
    // hidden reasoning having eaten the whole budget and no text at all.
    // That is the vendor's own semantics, identical when calling OpenAI
    // directly, and is not a reason to suppress the field here.
    //
    // The one upstream that must NOT see it is the codex/ChatGPT
    // backend, which allow-lists top-level params (a `max_output_tokens`
    // there was reported as 400 "Unsupported parameter" in #463).
    // `codex-oauth` runs last and only for subscription providers, so it
    // strips the field — that belongs with the rest of the codex-specific
    // requirements, not here, because this transformer also serves
    // api_key providers whose upstream is the real Responses API.
    const priorCompletionCap: unknown = Reflect.get(responsesReq, 'max_completion_tokens')
    const cap = typeof priorCompletionCap === 'number' ? priorCompletionCap : responsesReq.max_tokens
    delete responsesReq.max_tokens
    delete (responsesReq as { max_completion_tokens?: unknown }).max_completion_tokens
    if (typeof cap === 'number') responsesReq.max_output_tokens = cap

    // Manual per-model effort override wins over whatever the client
    // sent (typically inherited from Anthropic's `thinking` block).
    const effortOverride = provider?.modelReasoningEfforts?.[responsesReq.model ?? '']
    if (effortOverride) {
      // biome-ignore plugin: seeding the unified reasoning block so rewriteReasoning below picks up the override; the narrower unified type does not admit direct assignment.
      ;(responsesReq as unknown as { reasoning: { effort: string } }).reasoning = { effort: effortOverride }
    }

    rewriteReasoning(responsesReq)

    const input: unknown[] = []
    collectSystemMessages(responsesReq, input)

    // Defensive: same guard as collectSystemMessages — the body may
    // legitimately have no `messages` (OpenAI-compat caller sent an
    // empty request) and the transformer must not crash.
    for (const message of Array.isArray(responsesReq.messages) ? responsesReq.messages : []) {
      if (message.role === 'system') continue
      processNonSystemMessage(message, input)
    }

    responsesReq.input = input
    // biome-ignore plugin: the Responses API rejects `messages` — must be removed before sending; the unified schema does not model field removal.
    delete (responsesReq as { messages?: unknown }).messages

    if (Array.isArray(responsesReq.tools)) {
      const remapped = remapTools(responsesReq.tools)
      // biome-ignore plugin: the Responses API uses a flat `type/name/parameters` tool shape (no nested `function`); the unified UnifiedTool shape is reshaped here on the way out.
      ;(responsesReq as unknown as { tools: unknown }).tools = remapped
    }

    if (responsesReq.tool_choice !== undefined) {
      // biome-ignore plugin: same shape mismatch as `tools` — Responses expects `{type,name}` flat while unified nests the function name; the unified type cannot model the flat shape without breaking the Chat-Completions transformer.
      ;(responsesReq as unknown as { tool_choice: unknown }).tool_choice = remapToolChoice(responsesReq.tool_choice)
    }

    // Translate Chat-Completions `response_format` (top-level) into the
    // Responses-API `text.format` nested shape. Both surfaces support
    // the same three types (text / json_object / json_schema); only the
    // container differs — Chat wraps json_schema in a `json_schema` sub-
    // object while Responses flattens {name, schema, strict} up to the
    // format itself. Codex allow-lists top-level params and rejects
    // `response_format` outright, so leaving it top-level 400s the
    // whole request.
    const rawResponseFormat: unknown = Reflect.get(responsesReq, 'response_format')
    if (rawResponseFormat !== undefined) {
      const textFormat = convertResponseFormatToTextFormat(rawResponseFormat)
      if (textFormat !== null) {
        ;(responsesReq as unknown as { text: { format: unknown } }).text = { format: textFormat }
      }
      // biome-ignore plugin: response_format is a Chat-Completions field; delete after translation so the Responses upstream doesn't see it.
      delete (responsesReq as { response_format?: unknown }).response_format
    }

    responsesReq.parallel_tool_calls = false

    // Redirect to the Responses endpoint when the provider's
    // api_base_url points at /chat/completions. The codex subscription
    // provider's base URL is the ChatGPT backend root (no /chat/completions
    // segment), so this is a no-op there and codex-oauth still appends
    // /responses itself further down the chain.
    const base = provider?.api_base_url ?? ''
    if (base.includes('/chat/completions')) {
      const url = base.replace('/chat/completions', '/responses')
      return { body: responsesReq, config: { url } }
    }

    return responsesReq
  }

  async transformResponseOut(response: Response, _context: TransformerContext): Promise<Response> {
    const contentType = response.headers.get('Content-Type')
    if (typeof contentType !== 'string') return response

    if (contentType.includes('application/json')) {
      return this.handleJsonResponse(response)
    }

    if (contentType.includes('text/event-stream')) {
      return this.handleStreamResponse(response)
    }

    return response
  }

  private async handleJsonResponse(response: Response): Promise<Response> {
    const raw = await response.json()
    const parsed = ResponsesAPIPayloadSchema.safeParse(raw)
    if (!parsed.success) {
      throw new HTTPException(500, {
        message: `Invalid OpenAI Responses payload: ${JSON.stringify(parsed.error.issues)}`
      })
    }
    const jsonResponse: ResponsesAPIPayload = parsed.data

    // Check whether the JSON response is in the responses API format
    if (jsonResponse.object === 'response' && jsonResponse.output) {
      const chatResponse = convertResponseToChat(jsonResponse, this.logger)
      return cloneResponse(response, JSON.stringify(chatResponse))
    }

    return cloneResponse(response, JSON.stringify(jsonResponse))
  }

  private handleStreamResponse(response: Response): Response {
    if (!response.body) {
      return response
    }

    const upstreamBody = response.body
    const logger = this.logger

    const stream = new ReadableStream({
      async start(controller) {
        const session = new ResponsesStreamSession(controller, logger)
        await session.run(upstreamBody.getReader())
      }
    })

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      }
    })
  }
}

// Silence unused-type lint for the streaming inner item type re-exported
// from schemas — kept for editor IntelliSense on the SSE branch.
export type { ResponsesStreamItem }
