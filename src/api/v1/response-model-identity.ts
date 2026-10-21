/**
 * Client-visible response model identity.
 *
 * A route can select a concrete provider/model after a caller supplied an
 * alias, and a later candidate can replace it if an earlier attempt fails.
 * The client-visible model is the target Rialto selected for the successful
 * invocation, rather than an upstream alias or version string. A stream can
 * only honor that while its initial envelope is still recognizable; see
 * applyResponseModelIdentity.
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function applySelectedModel(payload: unknown, identity: SelectedModelIdentity): unknown {
  const selected = selectedModelOf(identity)
  if (selected === undefined || !isRecord(payload)) return payload

  const surface = surfaceForPath(identity.path)?.id
  if (surface === 'anthropic-messages' || surface === 'openai-chat' || surface === 'openai-responses') {
    return { ...payload, model: selected }
  }
  if (surface === 'gemini-generate') return { ...payload, modelVersion: selected }
  return payload
}

function applySelectedSseModel(payload: unknown, identity: SelectedModelIdentity): unknown {
  const selected = selectedModelOf(identity)
  if (selected === undefined || !isRecord(payload)) return payload

  const surface = surfaceForPath(identity.path)?.id
  if (surface === 'anthropic-messages') {
    if (payload.type !== 'message_start' || !isRecord(payload.message)) return payload
    return { ...payload, message: { ...payload.message, model: selected } }
  }
  if (surface === 'openai-responses') {
    if ((payload.type !== 'response.created' && payload.type !== 'response.completed') || !isRecord(payload.response)) {
      return payload
    }
    return { ...payload, response: { ...payload.response, model: selected } }
  }
  if (surface === 'gemini-generate' || surface === 'openai-chat') return applySelectedModel(payload, identity)
  return payload
}

async function patchBlockingJson(response: Response, identity: SelectedModelIdentity): Promise<Response> {
  const raw = await response.text()
  if (raw.length === 0)
    return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers })
  try {
    const patched = applySelectedModel(JSON.parse(raw), identity)
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
    const patched = applySelectedSseModel(JSON.parse(raw), identity)
    lines[dataIndex] = `${prefix}${JSON.stringify(patched)}`
  } catch {
    // An opaque SSE payload belongs to the upstream protocol. Preserve it
    // verbatim rather than making model observability break the response.
  }
  return `${lines.join('\n')}\n\n`
}

const ANTHROPIC_HEAD_LIMIT = 64 * 1024
const ANTHROPIC_PRELUDE_LIMIT = 32

function inspectAnthropicHead(
  raw: Uint8Array,
  identity: SelectedModelIdentity,
  initialRecord: boolean
): { kind: 'prelude' } | { kind: 'bypass' } | { kind: 'message'; bytes: Uint8Array } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)
    const bom = initialRecord && text.startsWith('\ufeff') ? '\ufeff' : ''
    const parts = text.slice(bom.length).split(/(\r?\n)/)
    const dataParts = parts.filter((part, index) => index % 2 === 0 && part.startsWith('data:'))
    if (dataParts.length === 0) return { kind: 'prelude' }
    const payload: unknown = JSON.parse(dataParts.map((part) => part.slice(5).replace(/^ /, '')).join('\n'))
    if (isRecord(payload) && payload.type === 'ping') return { kind: 'prelude' }
    if (!isRecord(payload) || payload.type !== 'message_start' || !isRecord(payload.message)) return { kind: 'bypass' }
    const firstDataIndex = parts.findIndex((part, index) => index % 2 === 0 && part.startsWith('data:'))
    const patched = JSON.stringify(applySelectedSseModel(payload, identity))
    const output = parts.flatMap((part, index) => {
      if (index % 2 === 1) return []
      const separator = index === 0 ? '' : parts[index - 1]
      if (!part.startsWith('data:')) return [separator + part]
      return index === firstDataIndex ? [`${separator}data: ${patched}`] : []
    })
    return { kind: 'message', bytes: new TextEncoder().encode(bom + output.join('')) }
  } catch {
    return { kind: 'bypass' }
  }
}

function headDelimiterLength(bytes: Uint8Array, length: number): number {
  if (bytes[length - 1] !== 10) return 0
  if (bytes[length - 2] === 10) return bytes[length - 3] === 13 ? 3 : 2
  if (bytes[length - 2] === 13 && bytes[length - 3] === 10) return bytes[length - 4] === 13 ? 4 : 3
  return 0
}

function pendingDelimiterLength(bytes: Uint8Array, length: number): number {
  if (bytes[length - 1] === 10) return bytes[length - 2] === 13 ? 2 : 1
  if (bytes[length - 1] === 13) {
    if (bytes[length - 2] === 10) return bytes[length - 3] === 13 ? 3 : 2
    return 1
  }
  return 0
}

function patchAnthropicSseResponse(response: Response, identity: SelectedModelIdentity): Response {
  if (!response.body) return response
  const state = { bytes: new Uint8Array(ANTHROPIC_HEAD_LIMIT + 4), length: 0, preludes: 0, raw: false }
  const bypass = (chunk: Uint8Array, offset: number, controller: TransformStreamDefaultController<Uint8Array>) => {
    const remaining = chunk.subarray(offset)
    const output = new Uint8Array(state.length + remaining.length)
    output.set(state.bytes.subarray(0, state.length))
    output.set(remaining, state.length)
    controller.enqueue(output)
    state.length = 0
    state.raw = true
  }
  const completeHead = (
    delimiter: number,
    chunk: Uint8Array,
    offset: number,
    controller: TransformStreamDefaultController<Uint8Array>
  ): boolean => {
    const headLength = state.length - delimiter
    const head = inspectAnthropicHead(state.bytes.subarray(0, headLength), identity, state.preludes === 0)
    if (headLength > ANTHROPIC_HEAD_LIMIT || head.kind === 'bypass') {
      bypass(chunk, offset, controller)
      return true
    }
    if (head.kind === 'prelude') {
      state.preludes += 1
      if (state.preludes > ANTHROPIC_PRELUDE_LIMIT) {
        bypass(chunk, offset, controller)
        return true
      }
      controller.enqueue(state.bytes.slice(0, state.length))
      state.length = 0
      return false
    }
    const output = new Uint8Array(head.bytes.length + delimiter)
    output.set(head.bytes)
    output.set(state.bytes.subarray(headLength, state.length), head.bytes.length)
    controller.enqueue(output)
    state.length = 0
    state.raw = true
    if (offset < chunk.length) controller.enqueue(chunk.subarray(offset))
    return true
  }
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (state.raw) {
        controller.enqueue(chunk)
        return
      }
      for (const [index, byte] of chunk.entries()) {
        state.bytes[state.length++] = byte
        const delimiter = headDelimiterLength(state.bytes, state.length)
        if (delimiter > 0) {
          if (completeHead(delimiter, chunk, index + 1, controller)) return
          continue
        }
        if (state.length - pendingDelimiterLength(state.bytes, state.length) > ANTHROPIC_HEAD_LIMIT) {
          bypass(chunk, index + 1, controller)
          return
        }
      }
    },
    flush(controller) {
      if (state.length > 0) controller.enqueue(state.bytes.slice(0, state.length))
    }
  })
  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

/**
 * Adds selected-target provenance and sets the wire model to that target.
 *
 * JSON needs one body read. Anthropic SSE rewrites a bounded initial envelope
 * and forwards the tail unchanged; oversized, opaque or incomplete heads pass
 * through without a body-model guarantee. Other SSE surfaces transform records.
 */
export async function applyResponseModelIdentity(
  response: Response,
  identity: SelectedModelIdentity
): Promise<Response> {
  if (!response.ok) return response
  const selected = selectedModelOf(identity)
  const headers = new Headers(response.headers)
  if (selected !== undefined) headers.set('x-rialto-selected-model', selected)
  const withHeader = new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  if (isSseContentType(withHeader.headers.get('content-type'))) {
    if (selected !== undefined && surfaceForPath(identity.path)?.id === 'anthropic-messages') {
      return patchAnthropicSseResponse(withHeader, identity)
    }
    return patchSseResponse(withHeader, identity)
  }
  return patchBlockingJson(withHeader, identity)
}
