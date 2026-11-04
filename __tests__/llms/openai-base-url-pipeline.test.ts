/**
 * One OpenAI provider, one Base URL, two wire formats — through the real
 * registry and pipeline.
 *
 * The operator stores a single Base URL for the provider, naming either
 * `/chat/completions` or `/responses`, and picks per model which wire
 * format that model is served over (`modelApiStyles`). Whatever the URL
 * says, a request must reach the endpoint of its own model's format, in
 * that format's body. A loopback upstream records what arrives.
 *
 * The bypass path is covered on purpose: a `/v1/chat/completions` caller on
 * a plain Chat model skips the transformer chain, so the URL has to be
 * corrected by the endpoint's `auth()` hook there, not by a chain step.
 */

import { describe, expect, test } from 'bun:test'
import pino from 'pino'
import { runPipeline } from '../../src/llms/pipeline'
import { ProviderRegistry } from '../../src/llms/registry/provider'
import { TransformerRegistry } from '../../src/llms/registry/transformer'
import { AnthropicTransformer, ClaudeCodeOauthTransformer } from '../../src/llms/transformers/anthropic'
import type { Transformer } from '../../src/llms/transformers/base'
import { OpenAIResponsesTransformer, OpenAITransformer } from '../../src/llms/transformers/openai'
import type { PipelineRequest } from '../../src/schemas/domain/pipeline'

type Bag = Record<string, unknown>

const log = pino({ level: 'silent' })

const CHAT_MODEL = 'gpt-5-mini'
const RESPONSES_MODEL = 'gpt-6-astra'

const CHAT_REPLY = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: CHAT_MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
}
const RESPONSES_REPLY = {
  id: 'resp_1',
  object: 'response',
  created_at: 1,
  model: RESPONSES_MODEL,
  output: [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
}

type Received = { path: string; authorization: string | null; body: Bag }

async function exchange(input: { baseTail: string; endpoint: 'chat' | 'responses'; body: Bag }) {
  const received: Received[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      received.push({ path, authorization: request.headers.get('authorization'), body: Object(await request.json()) })
      return Response.json(path === '/v1/responses' ? RESPONSES_REPLY : CHAT_REPLY)
    }
  })
  try {
    const transformers = new TransformerRegistry(log)
    transformers.registerMany([
      new AnthropicTransformer(),
      new ClaudeCodeOauthTransformer(),
      new OpenAITransformer(),
      new OpenAIResponsesTransformer()
    ])
    const providers = new ProviderRegistry(transformers, log)
    providers.registerFromConfig([
      {
        name: 'openai',
        api_style: 'openai_chat',
        auth_mode: 'api_key',
        api_base_url: new URL(input.baseTail, server.url).toString(),
        api_key: 'upstream-test-key',
        models: [CHAT_MODEL, RESPONSES_MODEL],
        modelApiStyles: { [RESPONSES_MODEL]: 'openai_responses' }
      }
    ])
    const provider = providers.get('openai')
    if (provider === undefined) throw new Error('provider was not registered')
    const transformer: Transformer =
      input.endpoint === 'chat' ? new OpenAITransformer() : new OpenAIResponsesTransformer()
    const surface: PipelineRequest['surface'] = input.endpoint === 'chat' ? 'openai-chat' : 'openai-responses'
    const headers = { authorization: 'Bearer client-rialto-token', 'content-type': 'application/json' }
    const model = typeof input.body.model === 'string' ? input.body.model : CHAT_MODEL
    const response = await runPipeline(
      {
        body: input.body,
        headers,
        provider,
        transformer,
        context: {
          req: {
            body: input.body,
            headers,
            url: input.endpoint === 'chat' ? '/v1/chat/completions' : '/v1/responses',
            provider: 'openai',
            model,
            surface,
            isSubagent: false,
            accountSessionKey: 'e2e'
          }
        }
      },
      { log }
    )
    return { received, status: response.status, reply: Object(await response.json()) }
  } finally {
    await server.stop(true)
  }
}

const chatBody = (model: string): Bag => ({
  model,
  messages: [{ role: 'user', content: 'ping' }],
  max_tokens: 64,
  reasoning_effort: 'high'
})

describe('a Chat model (the provider default)', () => {
  test('on a Chat Base URL goes to /chat/completions', async () => {
    const result = await exchange({ baseTail: '/v1/chat/completions', endpoint: 'chat', body: chatBody(CHAT_MODEL) })
    expect(result.received.map((r) => r.path)).toEqual(['/v1/chat/completions'])
    expect(result.received[0].authorization).toBe('Bearer upstream-test-key')
  })

  test('on a Responses Base URL still goes to /chat/completions (bypass path)', async () => {
    const result = await exchange({ baseTail: '/v1/responses', endpoint: 'chat', body: chatBody(CHAT_MODEL) })
    expect(result.received.map((r) => r.path)).toEqual(['/v1/chat/completions'])
    // Bypass: the caller's body goes through as it came.
    expect(result.received[0].body).toEqual(chatBody(CHAT_MODEL))
    expect(result.received[0].authorization).toBe('Bearer upstream-test-key')
    expect(Object(result.reply.choices[0]).message).toEqual({ role: 'assistant', content: 'pong' })
  })

  test('reached from /v1/responses on a Responses Base URL goes to /chat/completions (conversion path)', async () => {
    const result = await exchange({
      baseTail: '/v1/responses',
      endpoint: 'responses',
      body: { model: CHAT_MODEL, input: 'ping', stream: false }
    })
    expect(result.received.map((r) => r.path)).toEqual(['/v1/chat/completions'])
    expect(result.received[0].body.messages).toEqual([{ role: 'user', content: 'ping' }])
    expect('input' in result.received[0].body).toBe(false)
    expect(result.reply.object).toBe('response')
  })
})

describe('a model switched to Responses', () => {
  for (const baseTail of ['/v1/chat/completions', '/v1/responses']) {
    test(`on ${baseTail} goes to /responses with a Responses body`, async () => {
      const result = await exchange({ baseTail, endpoint: 'chat', body: chatBody(RESPONSES_MODEL) })
      expect(result.received.map((r) => r.path)).toEqual(['/v1/responses'])
      const body = result.received[0].body
      expect(result.received[0].authorization).toBe('Bearer upstream-test-key')
      expect(body.input).toEqual([{ role: 'user', content: 'ping' }])
      expect(body.max_output_tokens).toBe(64)
      // The Chat step must not have reshaped it first: the effort arrives as
      // the Responses object, not as a Chat scalar the upstream would refuse.
      expect(body.reasoning).toEqual({ effort: 'high', summary: 'detailed' })
      expect('reasoning_effort' in body).toBe(false)
      expect('max_completion_tokens' in body).toBe(false)
      expect('messages' in body).toBe(false)
      // And the reply is answered in the Chat format the caller spoke.
      expect(Object(result.reply.choices[0]).message).toMatchObject({ role: 'assistant', content: 'pong' })
    })
  }

  test('reached from /v1/responses goes to /responses too', async () => {
    const result = await exchange({
      baseTail: '/v1/chat/completions',
      endpoint: 'responses',
      body: { model: RESPONSES_MODEL, input: 'ping', reasoning: { effort: 'low' }, stream: false }
    })
    expect(result.received.map((r) => r.path)).toEqual(['/v1/responses'])
    expect(result.received[0].body.reasoning).toMatchObject({ effort: 'low' })
    // A text-only reply converts back to the envelope the caller asked for.
    expect(result.reply.object).toBe('response')
    expect(JSON.stringify(result.reply.output)).toContain('pong')
  })
})
