/**
 * A Codex response that fails after its stream opened.
 *
 * The ChatGPT backend answers 200, starts the SSE stream, and only then
 * reports a failure — `response.failed` with `response.error.{code,message}`,
 * `response.incomplete`, or a bare `error` event. The Responses → Chat
 * converter skipped all three, so the chat stream carried no chunk at all,
 * and the /v1/messages writer closed it with message_delta + message_stop
 * and no message_start. Claude Code saw that two-event husk as
 *
 *   Streaming response ended before any complete data was received
 *
 * and its non-streaming retry, folded from the same husk, as
 *
 *   API returned an empty or malformed response (HTTP 200) … body is JSON
 *   but not a Message
 *
 * blaming "a proxy or gateway" — while the upstream's actual reason never
 * left Rialto, and every later turn of the conversation failed the same way.
 */

import { describe, expect, test } from 'bun:test'
import { AnthropicTransformer } from '../../src/llms/transformers/anthropic'
import { OpenAIResponsesTransformer } from '../../src/llms/transformers/openai'
import { findSseStreamDefect } from '../../src/llms/utils/sse-aggregate'
import type { TransformerContext } from '../../src/schemas/domain'

const ctx = { req: { id: 'codex-failure' } } as unknown as TransformerContext

type Event = { type: string } & Record<string, unknown>

const frame = (event: Event): string => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`

// Codex's own framing: `event:` + `data:`, and no `[DONE]`.
const codexStream = (events: readonly Event[]): Response =>
  new Response(events.map(frame).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })

const response = (extra: Record<string, unknown>) => ({
  id: 'resp_1',
  model: 'gpt-5.5',
  output: [],
  usage: null,
  error: null,
  incomplete_details: null,
  ...extra
})

const created: Event = { type: 'response.created', response: response({ status: 'in_progress' }) }
const inProgress: Event = { type: 'response.in_progress', response: response({ status: 'in_progress' }) }
const failed = (code: string, message: string): Event => ({
  type: 'response.failed',
  response: response({ status: 'failed', error: { code, message } })
})

// The Codex provider chain's Responses conversion.
const toChat = (events: readonly Event[]): Promise<Response> =>
  new OpenAIResponsesTransformer().transformResponseOut(codexStream(events), ctx)

// …then the /v1/messages writer: what Claude Code receives.
async function toAnthropic(events: readonly Event[]): Promise<string> {
  const anthropic = await new AnthropicTransformer().transformResponseIn(await toChat(events), ctx)
  return anthropic.text()
}

const eventNames = (raw: string): string[] =>
  raw
    .split('\n')
    .filter((line) => line.startsWith('event:'))
    .map((line) => line.slice(6).trim())

const payloads = (raw: string): unknown[] =>
  raw
    .split('\n')
    .filter((line) => line.startsWith('data:') && line.slice(5).trim() !== '[DONE]')
    .map((line) => JSON.parse(line.slice(5)))

describe('a failure on an open Codex stream reaches Claude Code as an error', () => {
  test('response.failed becomes one Anthropic error event carrying the upstream message, and nothing after it', async () => {
    const message = 'Your input exceeds the context window of this model. Please adjust your input and try again.'
    const raw = await toAnthropic([created, inProgress, failed('context_length_exceeded', message)])
    expect(eventNames(raw)).toEqual(['error'])
    expect(payloads(raw)).toEqual([{ type: 'error', error: { type: 'invalid_request_error', message } }])
  })

  test('the non-stream retry finds the error and answers its status instead of a 200 husk', async () => {
    const overflow = await toAnthropic([created, failed('context_length_exceeded', 'too long')])
    expect(findSseStreamDefect(overflow)).toMatchObject({ reason: 'upstream-error', status: 400 })
    const limited = await toAnthropic([created, failed('rate_limit_exceeded', 'slow down')])
    expect(findSseStreamDefect(limited)).toMatchObject({ reason: 'upstream-error', status: 429 })
    const overloaded = await toAnthropic([created, failed('server_is_overloaded', 'busy')])
    expect(findSseStreamDefect(overloaded)).toMatchObject({ reason: 'upstream-error', status: 529 })
  })

  test('a code the table does not know is still an error, as api_error', async () => {
    const raw = await toAnthropic([created, failed('something_new', 'it broke')])
    expect(payloads(raw)).toEqual([{ type: 'error', error: { type: 'api_error', message: 'it broke' } }])
    expect(findSseStreamDefect(raw)).toMatchObject({ reason: 'upstream-error', status: 502 })
  })

  test('a failure with no message still says which event and code ended the response', async () => {
    const raw = await toAnthropic([
      created,
      { type: 'response.failed', response: response({ status: 'failed', error: { code: 'rate_limit_exceeded' } }) }
    ])
    const [event] = payloads(raw)
    expect(event).toMatchObject({ error: { type: 'rate_limit_error' } })
    expect(JSON.stringify(event)).toContain('response.failed: rate_limit_exceeded')
  })

  test('a bare error event, with its fields at the top level or nested, is an error too', async () => {
    const topLevel = await toAnthropic([
      created,
      { type: 'error', code: 'server_is_overloaded', message: 'try again later', param: null }
    ])
    expect(payloads(topLevel)).toEqual([
      { type: 'error', error: { type: 'overloaded_error', message: 'try again later' } }
    ])
    const nested = await toAnthropic([
      created,
      { type: 'error', error: { type: 'invalid_request_error', code: 'invalid_prompt', message: 'bad input' } }
    ])
    expect(payloads(nested)).toEqual([
      { type: 'error', error: { type: 'invalid_request_error', message: 'bad input' } }
    ])
  })

  test('an OpenAI chat client gets the {error:{…}} chunk its SDK throws on', async () => {
    const chat = await (await toChat([created, failed('context_length_exceeded', 'too long')])).text()
    expect(payloads(chat)).toEqual([
      { error: { message: 'too long', type: 'invalid_request_error', code: 'context_length_exceeded', param: null } }
    ])
  })
})

describe('response.incomplete', () => {
  test('an exhausted output budget is a truncated answer, not a failure', async () => {
    const raw = await toAnthropic([
      created,
      { type: 'response.output_item.added', output_index: 0, item: { id: 'm1', type: 'message', content: [] } },
      { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: 'partial' },
      {
        type: 'response.incomplete',
        response: response({
          status: 'incomplete',
          output: [{ type: 'message' }],
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
        })
      }
    ])
    const names = eventNames(raw)
    expect(names[0]).toBe('message_start')
    expect(names).not.toContain('error')
    expect(names.at(-1)).toBe('message_stop')
    expect(payloads(raw)).toContainEqual(
      expect.objectContaining({ delta: expect.objectContaining({ stop_reason: 'max_tokens' }) })
    )
  })

  test('any other reason is a failure that names it', async () => {
    const raw = await toAnthropic([
      created,
      {
        type: 'response.incomplete',
        response: response({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } })
      }
    ])
    expect(eventNames(raw)).toEqual(['error'])
    expect(JSON.stringify(payloads(raw))).toContain('reason: content_filter')
  })
})

describe('a stream that never started a message', () => {
  test('closes with no events rather than a message_delta + message_stop husk', async () => {
    // Created and in_progress, then the connection ends: nothing that
    // converts. This is the exact shape Claude Code counted as "2 stream
    // events received".
    const raw = await toAnthropic([created, inProgress])
    expect(eventNames(raw)).toEqual([])
    expect(findSseStreamDefect(raw)).toEqual({ reason: 'no-events' })
  })

  test('a healthy Codex stream still converts to a whole message', async () => {
    const raw = await toAnthropic([
      created,
      { type: 'response.output_item.added', output_index: 0, item: { id: 'm1', type: 'message', content: [] } },
      { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: 'pong' },
      {
        type: 'response.completed',
        response: response({
          status: 'completed',
          output: [{ type: 'message' }],
          usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9 }
        })
      }
    ])
    expect(eventNames(raw)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])
    expect(findSseStreamDefect(raw)).toBeNull()
  })
})
