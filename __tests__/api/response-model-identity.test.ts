import { describe, expect, test } from 'bun:test'
import { applyResponseModelIdentity } from '../../src/api/v1/response-model-identity'

const identity = (path: string, model = 'claude-sonnet-5') => ({ provider: 'anthropic', model, path })

const jsonResponse = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })

const sseResponse = (events: unknown[]): Response =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })

const sseEvents = async (response: Response): Promise<Record<string, unknown>[]> =>
  (await response.text())
    .split(/\r?\n\r?\n/)
    .filter((event) => event.startsWith('data:'))
    .map((event) => event.slice('data:'.length).trim())
    .filter((event) => event !== '[DONE]')
    .map((event) => JSON.parse(event) as Record<string, unknown>)

describe('applyResponseModelIdentity', () => {
  test('uses the successful selected target and exposes it as provenance', async () => {
    const response = await applyResponseModelIdentity(
      jsonResponse({ id: 'msg_1', type: 'message', model: '' }),
      identity('/v1/messages', 'claude-opus-5-5')
    )

    expect(response.headers.get('x-rialto-selected-model')).toBe('anthropic,claude-opus-5-5')
    expect((await response.json() as Record<string, unknown>).model).toBe('anthropic,claude-opus-5-5')
  })

  test('replaces an upstream-reported alias with the routed target', async () => {
    const response = await applyResponseModelIdentity(
      jsonResponse({ id: 'msg_1', type: 'message', model: 'claude-sonnet-5-20250929' }),
      identity('/v1/messages')
    )

    expect((await response.json() as Record<string, unknown>).model).toBe('anthropic,claude-sonnet-5')
    expect(response.headers.get('x-rialto-selected-model')).toBe('anthropic,claude-sonnet-5')
  })

  test('sets the selected model on every blocking response surface', async () => {
    const cases = [
      { path: '/v1/messages', payload: { model: '' }, field: 'model' },
      { path: '/v1/chat/completions', payload: { model: '' }, field: 'model' },
      { path: '/v1/responses', payload: { model: '' }, field: 'model' },
      { path: '/v1beta/models/gemini-3-pro:generateContent', payload: {}, field: 'modelVersion' }
    ]

    for (const current of cases) {
      const response = await applyResponseModelIdentity(jsonResponse(current.payload), identity(current.path))
      expect((await response.json() as Record<string, unknown>)[current.field]).toBe('anthropic,claude-sonnet-5')
    }
  })

  test('sets Anthropic message_start to the routed target', async () => {
    const missing = await applyResponseModelIdentity(
      sseResponse([{ type: 'message_start', message: { id: 'msg_1', model: 'unknown' } }]),
      identity('/v1/messages')
    )
    const existing = await applyResponseModelIdentity(
      sseResponse([{ type: 'message_start', message: { id: 'msg_1', model: 'claude-upstream' } }]),
      identity('/v1/messages')
    )

    expect((await sseEvents(missing))[0].message).toEqual({ id: 'msg_1', model: 'anthropic,claude-sonnet-5' })
    expect((await sseEvents(existing))[0].message).toEqual({ id: 'msg_1', model: 'anthropic,claude-sonnet-5' })
  })

  test('fills both Responses lifecycle envelopes in a live stream', async () => {
    const response = await applyResponseModelIdentity(
      sseResponse([
        { type: 'response.created', response: { id: 'resp_1', model: '' } },
        { type: 'response.completed', response: { id: 'resp_1', model: '' } }
      ]),
      identity('/v1/responses')
    )

    const events = await sseEvents(response)
    expect((events[0].response as Record<string, unknown>).model).toBe('anthropic,claude-sonnet-5')
    expect((events[1].response as Record<string, unknown>).model).toBe('anthropic,claude-sonnet-5')
  })

  test('leaves malformed SSE payloads relayable', async () => {
    const response = await applyResponseModelIdentity(
      new Response('event: opaque\ndata: not-json\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      }),
      identity('/v1/messages')
    )

    expect(await response.text()).toBe('event: opaque\ndata: not-json\n\n')
  })
})
