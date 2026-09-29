/**
 * Client-visible response model identity.
 *
 * A route can select a concrete provider/model after a caller supplied an
 * alias, and failover can select a later candidate. Providers do not always
 * return that model in their response, especially on streamed subscription
 * paths. Preserve an upstream-reported identity when it exists; when it does
 * not, expose the successful invocation's selected target as a fallback.
 */

import { surfaceForPath } from '../../llms/inbound/surfaces'
import { isSseContentType } from '../../llms/utils/sse-aggregate'

export type SelectedModelIdentity = {
  provider: string
  model: string | undefined
  path: string
}

const selectedModelOf = (identity: SelectedModelIdentity): string | undefined =>
  identity.model !== undefined && identity.model.length > 0 ? `${identity.provider},${identity.model}` : undefined

const hasModel = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value !== 'unknown'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function applyModelFallback(payload: unknown, identity: SelectedModelIdentity): unknown {
  const selected = selectedModelOf(identity)
  if (selected === undefined || !isRecord(payload)) return payload

  const surface = surfaceForPath(identity.path)?.id
  if (surface === 'anthropic-messages' || surface === 'openai-chat' || surface === 'openai-responses') {
    return hasModel(payload.model) ? payload : { ...payload, model: selected }
  }
  if (surface === 'gemini-generate') {
    return hasModel(payload.modelVersion) ? payload : { ...payload, modelVersion: selected }
  }
  return payload
}

function applySseModelFallback(payload: unknown, identity: SelectedModelIdentity): unknown {
  const selected = selectedModelOf(identity)
  if (selected === undefined || !isRecord(payload)) return payload

  const surface = surfaceForPath(identity.path)?.id
  if (surface === 'anthropic-messages') {
    if (payload.type !== 'message_start' || !isRecord(payload.message)) return payload
    return hasModel(payload.message.model) ? payload : { ...payload, message: { ...payload.message, model: selected } }
  }
  if (surface === 'openai-responses') {
    if ((payload.type !== 'response.created' && payload.type !== 'response.completed') || !isRecord(payload.response)) {
      return payload
    }
    return hasModel(payload.response.model)
      ? payload
      : { ...payload, response: { ...payload.response, model: selected } }
  }
  if (surface === 'gemini-generate' || surface === 'openai-chat') return applyModelFallback(payload, identity)
  return payload
}

async function patchBlockingJson(response: Response, identity: SelectedModelIdentity): Promise<Response> {
  const raw = await response.text()
  if (raw.length === 0) return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers })
  try {
    const patched = applyModelFallback(JSON.parse(raw), identity)
    return new Response(JSON.stringify(patched), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  } catch {
    return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}

function patchSseResponse(response: Response, identity: SelectedModelIdentity): Response {
  if (!response.body) return response
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const state = { buffered: '' }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      state.buffered += decoder.decode(chunk, { stream: true })
      const events = state.buffered.split(/\r?\n\r?\n/)
      state.buffered = events.pop() ?? ''
      for (const event of events) controller.enqueue(encoder.encode(patchSseEvent(event, identity)))
    },
    flush(controller) {
      state.buffered += decoder.decode()
      if (state.buffered.length > 0) controller.enqueue(encoder.encode(patchSseEvent(state.buffered, identity)))
    }
  })
  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

function patchSseEvent(event: string, identity: SelectedModelIdentity): string {
  const lines = event.split(/\r?\n/)
  const dataIndex = lines.findIndex((line) => line.startsWith('data:'))
  if (dataIndex < 0) return `${event}\n\n`
  const prefix = lines[dataIndex].match(/^data:\s*/)?.[0]
  if (prefix === undefined) return `${event}\n\n`
  const raw = lines[dataIndex].slice(prefix.length)
  if (raw === '[DONE]') return `${event}\n\n`
  try {
    const patched = applySseModelFallback(JSON.parse(raw), identity)
    lines[dataIndex] = `${prefix}${JSON.stringify(patched)}`
  } catch {
    // An opaque SSE payload belongs to the upstream protocol. Preserve it
    // verbatim rather than making model observability break the response.
  }
  return `${lines.join('\n')}\n\n`
}

/**
 * Adds selected-target provenance and fills only missing wire model fields.
 *
 * JSON needs one body read to add a field. SSE stays incremental: complete
 * SSE records are transformed as they arrive and are never accumulated beyond
 * one event boundary.
 */
export async function applyResponseModelIdentity(
  response: Response,
  identity: SelectedModelIdentity
): Promise<Response> {
  const selected = selectedModelOf(identity)
  const headers = new Headers(response.headers)
  if (selected !== undefined) headers.set('x-rialto-selected-model', selected)
  const withHeader = new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  if (!withHeader.ok) return withHeader
  if (isSseContentType(withHeader.headers.get('content-type'))) return patchSseResponse(withHeader, identity)
  return patchBlockingJson(withHeader, identity)
}
