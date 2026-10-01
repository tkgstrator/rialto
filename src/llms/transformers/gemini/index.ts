/**
 * Gemini endpoint transformer.
 *
 * Owns `/v1beta/models/:modelAndAction` in both directions:
 *
 *   - as the OUTBOUND transformer on a `google` provider, converting a
 *     unified request into Gemini's `generateContent` wire shape,
 *   - as the INBOUND endpoint transformer for the gemini surface, where
 *     a Gemini client's own request arrives and has to be understood.
 *
 * When both ends are Gemini the pipeline takes its bypass path — no
 * conversion is needed, the body is already in the right shape — and
 * calls `auth` instead of the transform hooks. That hook has to rebuild
 * the outbound URL, because the model and action live in the path and a
 * provider's `api_base_url` only names the collection they hang off.
 *
 * The body / response shape work is delegated to the shared
 * gemini-conversion util (`buildRequestBody`, `transformRequestOut`,
 * `transformResponseOut`) because the same conversion is reused by
 * vertex-gemini.
 */

import type { RuntimeProvider, TransformerContext, TransformerHookResult, UnifiedChatRequest } from '@/schemas/domain'
import { RecordSchema } from '@/schemas/primitives/record'
import { buildRequestBody, transformRequestOut, transformResponseOut } from '../../utils/gemini-conversion'
import { convertChatCompletionToGemini, convertChatStreamToGeminiSse } from '../../utils/gemini-inbound-response'
import { Transformer, type TransformerAuthResult } from '../base'

/**
 * Build the concrete `generateContent` / `streamGenerateContent` URL for
 * one model.
 *
 * `api_base_url` points at the collection (`.../v1beta/models/`) and the
 * action hangs off it, so the trailing slash is load-bearing: without it
 * `new URL('./x', base)` resolves against the parent and drops `models`
 * from the path. Seeded providers carry it; a hand-edited one may not,
 * so it is enforced here rather than assumed.
 */
function geminiEndpointUrl(apiBaseUrl: string, model: string, stream: boolean): URL {
  const base = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`
  const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent'
  return new URL(`./${model}:${action}`, base)
}

export class GeminiTransformer extends Transformer {
  readonly name = 'gemini'
  readonly endPoint = '/v1beta/models/:modelAndAction'

  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: RuntimeProvider,
    _context: TransformerContext
  ): Promise<TransformerHookResult> {
    return {
      body: buildRequestBody(request),
      config: {
        outboundModel: request.model,
        url: geminiEndpointUrl(provider.api_base_url, request.model, request.stream === true),
        headers: {
          'x-goog-api-key': provider.api_key,
          Authorization: undefined
        }
      }
    }
  }

  /**
   * Bypass-path hook: a Gemini client talking to a Gemini provider.
   *
   * The body already is a `generateContent` request, so nothing is
   * converted. Two things still have to happen, and neither can be done
   * anywhere else:
   *
   *   - The URL has to name the model and the action. The route folded
   *     both out of the inbound path onto the body (see
   *     `route-plan.ts`), because everything between here and there
   *     reads `body.model` / `body.stream`. This is where they go back
   *     into the URL, and where they are removed from the body — Google
   *     rejects unknown top-level fields with INVALID_ARGUMENT.
   *   - The provider's own key has to replace whatever credential the
   *     client presented. `x-goog-api-key` is set here for that reason;
   *     the inbound copy is also stripped upstream of this hook, so a
   *     client's Rialto token can never reach Google even if this hook
   *     changes.
   */
  async auth(
    request: unknown,
    provider: RuntimeProvider,
    _context: TransformerContext
  ): Promise<TransformerAuthResult> {
    const parsed = RecordSchema.safeParse(request)
    const body: Record<string, unknown> = parsed.success ? { ...parsed.data } : {}
    const model = typeof body.model === 'string' ? body.model : ''
    const stream = body.stream === true
    delete body.model
    delete body.stream
    return {
      body,
      config: {
        outboundModel: model.length > 0 ? model : undefined,
        url: geminiEndpointUrl(provider.api_base_url, model, stream),
        headers: {
          'x-goog-api-key': provider.api_key,
          Authorization: undefined
        }
      }
    }
  }

  async transformRequestOut(request: unknown, _context: TransformerContext): Promise<UnifiedChatRequest> {
    return transformRequestOut(RecordSchema.parse(request))
  }

  async transformResponseOut(response: Response, _context: TransformerContext): Promise<Response> {
    return transformResponseOut(response, this.name, this.logger)
  }

  /**
   * Final shaping for a Gemini CLIENT.
   *
   * Only runs on the converted path — a Gemini client served by a Gemini
   * provider bypasses the whole chain, and the upstream body already is
   * what the client wants. On every other provider the pipeline hands
   * back its internal OpenAI-shaped response, and a Gemini SDK reading
   * that finds no `candidates` and reports an empty answer rather than
   * an error. This is where that is put right.
   */
  async transformResponseIn(response: Response, _context?: TransformerContext): Promise<Response> {
    const contentType = response.headers.get('content-type')
    if (contentType?.includes('text/event-stream') === true) {
      if (!response.body) return response
      return new Response(convertChatStreamToGeminiSse(response.body, this.logger), {
        status: response.status,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        }
      })
    }
    const payload: unknown = await response.json().catch(() => null)
    if (payload === null) return response
    return new Response(JSON.stringify(convertChatCompletionToGemini(payload, this.logger)), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}
