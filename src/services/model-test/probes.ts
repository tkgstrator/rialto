/**
 * Vendor-specific real-inference probes: a minimal 1-token completion
 * request shaped for each API style, dispatched by `probeInference`.
 */

import { ApiStyle } from '../../generated/prisma/client'
import { fetchWithTimeout, formatHttpError, type ProbeResult, reachable } from './http'

const probeAnthropic = async (
  baseUrl: string,
  apiKey: string,
  model: string,
  extraHeaders: Record<string, string>
): Promise<ProbeResult> => {
  const res = await fetchWithTimeout(baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      ...extraHeaders
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }]
    })
  })
  if (res.ok) return { ok: true }
  const ab = (await res.text()).slice(0, 300)
  if (reachable(res.status, ab)) return { ok: true }
  return { ok: false, error: formatHttpError(res.status, ab) }
}

const probeGemini = async (
  baseUrl: string,
  apiKey: string,
  model: string,
  extraHeaders: Record<string, string>
): Promise<ProbeResult> => {
  // baseUrl ends with /v1beta/models/ — resolve relative to it.
  const url = new URL(`./${model}:generateContent`, baseUrl)
  url.searchParams.set('key', apiKey)
  const res = await fetchWithTimeout(url.href, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify({
      contents: [{ parts: [{ text: 'ping' }] }],
      generationConfig: { maxOutputTokens: 1 }
    })
  })
  if (res.ok) return { ok: true }
  return { ok: false, error: formatHttpError(res.status, (await res.text()).slice(0, 300)) }
}

// OpenAI Responses API call. The provider's base URL may be the
// chat-completions endpoint (codex models live under the regular
// openai provider via a per-model apiStyle override), so normalise
// it to /responses; if it's already /responses it's unchanged.
const probeResponses = async (
  chatOrResponsesUrl: string,
  apiKey: string,
  model: string,
  extraHeaders: Record<string, string>
): Promise<ProbeResult> => {
  // Normalise to the /responses endpoint: replace a trailing
  // /chat/completions, otherwise append /responses if absent.
  const responsesUrl = /\/responses\/?$/.test(chatOrResponsesUrl)
    ? chatOrResponsesUrl
    : /\/chat\/completions\/?$/.test(chatOrResponsesUrl)
      ? chatOrResponsesUrl.replace(/\/chat\/completions(\/?)$/, '/responses$1')
      : `${chatOrResponsesUrl.replace(/\/$/, '')}/responses`
  const res = await fetchWithTimeout(responsesUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      ...extraHeaders
    },
    // chatgpt.com/backend-api/codex requires: `instructions`,
    // `input` as a list, store=false, stream=true. All are valid
    // on the public Responses API too, so one body serves both.
    //
    // The cap is 16 because that is the Responses API's documented
    // minimum: api.openai.com answers 400 "integer_below_min_value"
    // ("Expected a value >= 16") for anything smaller. This probe used
    // to send 1, which never reached the model at all — it failed
    // parameter validation, and `budgetExhausted` counted that 400 as a
    // pass because its pattern matched the field name in the error text.
    // 16 keeps the probe cheap while actually exercising the model.
    body: JSON.stringify({
      model,
      instructions: 'ping',
      input: [{ role: 'user', content: 'ping' }],
      max_output_tokens: 16,
      store: false,
      stream: true
    })
  })
  if (res.ok) {
    // Streaming response — a 200 means auth + reachability are
    // proven; don't consume the stream, just release it.
    await res.body?.cancel().catch(() => {})
    return { ok: true }
  }
  const rbody = (await res.text()).slice(0, 300)
  if (reachable(res.status, rbody)) return { ok: true }
  return { ok: false, error: formatHttpError(res.status, rbody) }
}

// ApiStyle.openai_chat — chat completions; baseUrl is the chat
// endpoint. gpt-5 / o-series reject `max_tokens` and require
// `max_completion_tokens`; older gpt-4 / OpenAI-compatible vendors
// only know `max_tokens`. Send `max_tokens` first and retry once
// with `max_completion_tokens` when the vendor explicitly rejects
// the former, so both generations pass.
const probeOpenAIChat = async (baseUrl: string, apiKey: string, model: string): Promise<ProbeResult> => {
  const callChat = (tokenField: 'max_tokens' | 'max_completion_tokens') =>
    fetchWithTimeout(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        [tokenField]: 1,
        messages: [{ role: 'user', content: 'ping' }]
      })
    })

  const res = await callChat('max_tokens')
  if (res.ok) return { ok: true }
  const body = (await res.text()).slice(0, 300)
  if (reachable(res.status, body)) return { ok: true }
  const wantsCompletionTokens = res.status === 400 && /max_tokens/.test(body) && /max_completion_tokens/.test(body)
  if (wantsCompletionTokens) {
    const retry = await callChat('max_completion_tokens')
    if (retry.ok) return { ok: true }
    const retryBody = (await retry.text()).slice(0, 300)
    if (reachable(retry.status, retryBody)) return { ok: true }
    return { ok: false, error: formatHttpError(retry.status, retryBody) }
  }
  return { ok: false, error: formatHttpError(res.status, body) }
}

export const probeInference = async (
  style: ApiStyle,
  baseUrl: string,
  apiKey: string,
  model: string,
  // Extra headers for subscription auth (e.g. codex's
  // chatgpt-account-id). Merged into every variant's request.
  extraHeaders: Record<string, string> = {}
): Promise<ProbeResult> => {
  try {
    if (style === ApiStyle.anthropic) {
      return await probeAnthropic(baseUrl, apiKey, model, extraHeaders)
    }
    if (style === ApiStyle.gemini) {
      return await probeGemini(baseUrl, apiKey, model, extraHeaders)
    }
    if (style === ApiStyle.openai_responses) {
      // baseUrl is already the /v1/responses endpoint.
      return await probeResponses(baseUrl, apiKey, model, extraHeaders)
    }
    return await probeOpenAIChat(baseUrl, apiKey, model)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' }
  }
}
