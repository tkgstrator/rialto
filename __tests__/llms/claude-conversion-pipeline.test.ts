/**
 * Claude behind an OpenAI surface, through the real registry and pipeline.
 *
 * `/v1/responses` and `/v1/chat/completions` answer in their own format
 * whatever model they are routed to. Routed to Claude, the request goes
 * through the ordinary conversion path — surface → unified → the Claude
 * step's `transformRequestIn` → Anthropic — and the reply comes back the
 * same way. A loopback upstream stands in for Anthropic, so what is sent
 * and what the client gets are both checked without credentials.
 *
 * The bypass path is pinned beside it: a `/v1/messages` caller on the
 * same subscription provider still goes upstream exactly as `auth()`
 * shapes it, and its stream comes back untouched.
 */

import { describe, expect, test } from 'bun:test'
import pino from 'pino'
import type { UsageRecord } from '../../src/llms/pipeline'
import { runPipeline } from '../../src/llms/pipeline'
import { ProviderRegistry } from '../../src/llms/registry/provider'
import { TransformerRegistry } from '../../src/llms/registry/transformer'
import { AnthropicTransformer, ClaudeCodeOauthTransformer } from '../../src/llms/transformers/anthropic'
import type { Transformer } from '../../src/llms/transformers/base'
import type { OauthCredentials } from '../../src/llms/transformers/oauth-base'
import { OpenAIResponsesTransformer, OpenAITransformer } from '../../src/llms/transformers/openai'
import type { PipelineRequest } from '../../src/schemas/domain/pipeline'

type Bag = Record<string, unknown>

const log = pino({ level: 'silent' })
const model = 'claude-opus-5-5'
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

class StubbedClaudeCode extends ClaudeCodeOauthTransformer {
  protected async resolveSubscriptionAuth(): Promise<OauthCredentials> {
    return { token: 'claude-oauth-token' }
  }
}

const frame = (event: Bag): string => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
const ANTHROPIC_STREAM = [
  {
    type: 'message_start',
    message: {
      id: 'msg_e2e',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 1 }
    }
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
  { type: 'message_stop' }
]
  .map(frame)
  .join('')

type Received = { path: string; headers: Headers; body: Bag }

async function exchange(input: {
  provider: 'api_key' | 'subscription'
  transformer: Transformer
  path: string
  body: Bag
}) {
  const received: Received[] = []
  const usage: UsageRecord[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      received.push({
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: Object(await request.json())
      })
      return new Response(ANTHROPIC_STREAM, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
    }
  })
  try {
    const transformers = new TransformerRegistry(log)
    transformers.registerMany([
      new AnthropicTransformer(),
      new StubbedClaudeCode(),
      new OpenAITransformer(),
      new OpenAIResponsesTransformer()
    ])
    const providers = new ProviderRegistry(transformers, log)
    providers.registerFromConfig([
      {
        name: 'claude',
        api_style: 'anthropic',
        auth_mode: input.provider,
        api_base_url: new URL('/v1/messages', server.url).toString(),
        api_key: input.provider === 'subscription' ? 'oauth' : 'upstream-test-key',
        models: [model],
        modelSupportedEfforts: { [model]: ['low', 'medium', 'high', 'xhigh', 'max'] }
      }
    ])
    const provider = providers.get('claude')
    if (provider === undefined) throw new Error('provider was not registered')
    const headers = {
      authorization: 'Bearer client-rialto-token',
      'anthropic-version': '2023-06-01',
      host: 'inbound.test'
    }
    const surface: PipelineRequest['surface'] =
      input.path === '/v1/responses'
        ? 'openai-responses'
        : input.path === '/v1/messages'
          ? 'anthropic-messages'
          : 'openai-chat'
    const response = await runPipeline(
      {
        body: input.body,
        headers,
        provider,
        transformer: input.transformer,
        context: {
          req: {
            body: input.body,
            headers,
            url: input.path,
            provider: 'claude',
            model,
            surface,
            isSubagent: false,
            accountSessionKey: 'e2e'
          }
        }
      },
      {
        log,
        recordUsage: async (row) => {
          usage.push(row)
        }
      }
    )
    const text = await response.text()
    // Usage is captured off a clone of the upstream body, after the fact.
    for (const _ of Array.from({ length: 50 })) {
      if (usage.length > 0) break
      await Bun.sleep(10)
    }
    return { received, text, contentType: response.headers.get('content-type'), usage }
  } finally {
    await server.stop(true)
  }
}

const dataOf = (text: string): Bag[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('data:') && line.slice(5).trim() !== '[DONE]')
    .map((line) => Object(JSON.parse(line.slice(5))))

describe('/v1/responses routed to an Anthropic API-key provider', () => {
  const body = {
    model,
    instructions: 'Be terse.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
    reasoning: { effort: 'low' },
    stream: true,
    store: false
  }

  test('sends Anthropic Messages with the provider key, and answers in Responses events', async () => {
    const result = await exchange({
      provider: 'api_key',
      transformer: new OpenAIResponsesTransformer(),
      path: '/v1/responses',
      body
    })
    expect(result.received).toHaveLength(1)
    const sent = result.received[0]
    expect(sent.path).toBe('/v1/messages')
    expect(sent.headers.get('x-api-key')).toBe('upstream-test-key')
    expect(sent.headers.get('anthropic-version')).toBe('2023-06-01')
    // The key goes once, as x-api-key — and the client's token not at all.
    expect(sent.headers.get('authorization')).toBeNull()
    expect(sent.body).toEqual({
      model,
      max_tokens: 32000,
      system: [{ type: 'text', text: 'Be terse.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping', cache_control: { type: 'ephemeral' } }] }],
      output_config: { effort: 'low' },
      stream: true
    })
    expect(result.contentType).toContain('text/event-stream')
    const events = dataOf(result.text)
    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.output_item.done',
      'response.completed'
    ])
    expect(Object(events.at(-1)?.response).output[0].content[0].text).toBe('pong')
  })

  test('the request row still carries the Anthropic usage, read off the raw upstream', async () => {
    const result = await exchange({
      provider: 'api_key',
      transformer: new OpenAIResponsesTransformer(),
      path: '/v1/responses',
      body
    })
    expect(result.usage).toHaveLength(1)
    expect(result.usage[0]).toMatchObject({
      provider: 'claude',
      model,
      surface: 'openai-responses',
      inputTokens: 12,
      cacheReadTokens: 100,
      cacheWriteTokens: 5,
      outputTokens: 7,
      totalInputTokens: 117
    })
  })
})

describe('/v1/chat/completions routed to a Claude subscription', () => {
  test('sends Anthropic Messages with the bearer, the OAuth beta and the identity; answers in chat chunks', async () => {
    const result = await exchange({
      provider: 'subscription',
      transformer: new OpenAITransformer(),
      path: '/v1/chat/completions',
      body: {
        model,
        messages: [{ role: 'user', content: 'ping' }],
        stream: true,
        stream_options: { include_usage: true }
      }
    })
    const sent = result.received[0]
    expect(sent.headers.get('authorization')).toBe('Bearer claude-oauth-token')
    expect(sent.headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
    expect(sent.headers.get('x-api-key')).toBeNull()
    expect(sent.body).toEqual({
      model,
      max_tokens: 32000,
      system: [{ type: 'text', text: IDENTITY }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping', cache_control: { type: 'ephemeral' } }] }],
      stream: true
    })
    const chunks = dataOf(result.text)
    expect(chunks.every((chunk) => chunk.object === 'chat.completion.chunk')).toBe(true)
    expect(chunks.map((chunk) => Object(Object(chunk.choices)[0]).delta.content).join('')).toBe('pong')
    expect(result.text.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })
})

describe('/v1/messages on the same subscription — the bypass path', () => {
  test('goes upstream as auth() shapes it, and its stream comes back byte for byte', async () => {
    const native = {
      model,
      max_tokens: 1024,
      system: [{ type: 'text', text: 'native system', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      thinking: { type: 'adaptive' },
      stream: true
    }
    const transformer = new StubbedClaudeCode()
    const result = await exchange({
      provider: 'subscription',
      transformer,
      path: '/v1/messages',
      body: structuredClone(native)
    })
    const sent = result.received[0]
    expect(sent.body).toEqual({
      ...native,
      system: [{ type: 'text', text: IDENTITY }, ...native.system]
    })
    expect(sent.headers.get('authorization')).toBe('Bearer claude-oauth-token')
    expect(result.text).toBe(ANTHROPIC_STREAM)
  })
})
