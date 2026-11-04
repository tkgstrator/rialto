/**
 * Vendor-specific real-inference probes for api_key providers: a minimal
 * completion request shaped for each API style, dispatched by
 * `probeInference`. Subscription providers do not come through here; they
 * are probed with the proxy's own transformer chain (subscription-probe.ts).
 */

import { ApiStyle } from '../../generated/prisma/client'
import { retargetOpenAIUrl } from '../../llms/utils/openai-endpoint'
import { fetchWithTimeout, formatHttpError, type ProbeResult, reachable } from './http'

const probeAnthropic = async (baseUrl: string, apiKey: string, model: string): Promise<ProbeResult> => {
  const res = await fetchWithTimeout(baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
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

const probeGemini = async (baseUrl: string, apiKey: string, model: string): Promise<ProbeResult> => {
  // baseUrl ends with /v1beta/models/ — resolve relative to it.
  const url = new URL(`./${model}:generateContent`, baseUrl)
  url.searchParams.set('key', apiKey)
  const res = await fetchWithTimeout(url.href, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: 'ping' }] }],
      generationConfig: { maxOutputTokens: 1 }
    })
  })
  if (res.ok) return { ok: true }
  return { ok: false, error: formatHttpError(res.status, (await res.text()).slice(0, 300)) }
}

// OpenAI Responses API call. The provider's Base URL may name either
// endpoint — /chat/completions or /responses — because one provider hosts
// models on both wire formats, so it is pointed at /responses here. A URL
// naming neither gets /responses appended.
const probeResponses = async (chatOrResponsesUrl: string, apiKey: string, model: string): Promise<ProbeResult> => {
  const retargeted = retargetOpenAIUrl(chatOrResponsesUrl, 'responses')
  const responsesUrl = retargeted === null ? `${chatOrResponsesUrl.replace(/\/$/, '')}/responses` : retargeted
  const res = await fetchWithTimeout(responsesUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    // The cap is 16 because that is the Responses API's documented
    // minimum: api.openai.com answers 400 "integer_below_min_value"
    // ("Expected a value >= 16") for anything smaller. This probe used
    // to send 1, which never reached the model at all — it failed
    // parameter validation, and `budgetExhausted` counted that 400 as a
    // pass because its pattern matched the field name in the error text.
    // 16 keeps the probe cheap while actually exercising the model.
    //
    // Only the public Responses API gets this body. The Codex subscription
    // backend refuses `max_output_tokens` outright, which is why it is
    // probed through codex-oauth instead of here.
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

// ApiStyle.openai_chat — chat completions. The Base URL may name /responses
// instead (see probeResponses), so it is pointed at /chat/completions; a URL
// naming neither is used as stored.
//
// gpt-5 / o-series reject `max_tokens` and require `max_completion_tokens`;
// older gpt-4 / OpenAI-compatible vendors only know `max_tokens`. Send
// `max_tokens` first and retry once with `max_completion_tokens` when the
// vendor explicitly rejects the former, so both generations pass.
const probeOpenAIChat = async (baseUrl: string, apiKey: string, model: string): Promise<ProbeResult> => {
  const retargeted = retargetOpenAIUrl(baseUrl, 'chat')
  const chatUrl = retargeted === null ? baseUrl : retargeted
  const callChat = (tokenField: 'max_tokens' | 'max_completion_tokens') =>
    fetchWithTimeout(chatUrl, {
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
  model: string
): Promise<ProbeResult> => {
  try {
    if (style === ApiStyle.anthropic) {
      return await probeAnthropic(baseUrl, apiKey, model)
    }
    if (style === ApiStyle.gemini) {
      return await probeGemini(baseUrl, apiKey, model)
    }
    if (style === ApiStyle.openai_responses) {
      return await probeResponses(baseUrl, apiKey, model)
    }
    return await probeOpenAIChat(baseUrl, apiKey, model)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' }
  }
}
