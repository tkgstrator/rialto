/**
 * The real registry and HTTP pipeline must preserve native Anthropic traffic.
 * An empty API-key chain used to convert requests to Chat format and interpret
 * native responses as Chat completions. A loopback upstream keeps these
 * regressions independent of credentials, a database, or a live model.
 */

import { describe, expect, test } from 'bun:test'
import pino from 'pino'
import { runPipeline } from '../../src/llms/pipeline'
import { ProviderRegistry } from '../../src/llms/registry/provider'
import { TransformerRegistry } from '../../src/llms/registry/transformer'
import { AnthropicTransformer } from '../../src/llms/transformers/anthropic'

const log = pino({ level: 'silent' })
const model = 'claude-sonnet-5'
const classifierRequest = {
  model,
  max_tokens: 1024,
  system: [{ type: 'text', text: 'Classify whether this harmless calculation is permitted.' }],
  messages: [{ role: 'user', content: 'Action: python3 -c "print(17 * 19)"' }],
  stop_sequences: ['</severity>'],
  thinking: { type: 'disabled' },
  metadata: { user_id: 'classifier-test' }
}
const classifierResponse = {
  id: 'msg_classifier_test',
  type: 'message',
  role: 'assistant',
  model,
  content: [{ type: 'text', text: '<severity>0</severity>' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 128, output_tokens: 8 }
}

async function exchange(body: Record<string, unknown>, upstream: Response) {
  const received: Array<{ method: string; path: string; headers: Headers; body: unknown }> = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      received.push({
        method: request.method,
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: await request.json()
      })
      return upstream.clone()
    }
  })

  try {
    const transformer = new AnthropicTransformer()
    const transformers = new TransformerRegistry(log)
    transformers.registerMany([transformer])
    const providers = new ProviderRegistry(transformers, log)
    providers.registerFromConfig([
      {
        name: 'anthropic',
        api_style: 'anthropic',
        auth_mode: 'api_key',
        api_base_url: new URL('/v1/messages', server.url).toString(),
        api_key: 'upstream-test-key',
        models: [model]
      }
    ])
    const provider = providers.get('anthropic')
    if (provider === undefined) throw new Error('Native provider was not registered')

    const headers = {
      'anthropic-version': '2023-06-01',
      'x-api-key': 'client-rialto-token',
      authorization: 'Bearer client-rialto-token',
      host: 'inbound.example.test',
      'cf-ray': 'inbound-proxy-trace'
    }
    const response = await runPipeline(
      {
        body,
        headers,
        provider,
        transformer,
        context: {
          req: {
            body,
            headers,
            url: '/v1/messages',
            provider: provider.name,
            model,
            accountSessionKey: 'native-pipeline-test'
          }
        }
      },
      { log }
    )
    return {
      received,
      status: response.status,
      contentType: response.headers.get('content-type'),
      text: await response.text()
    }
  } finally {
    await server.stop(true)
  }
}

describe('Anthropic API-key native pipeline', () => {
  test('preserves the complete classifier request and native JSON response', async () => {
    const result = await exchange(classifierRequest, Response.json(classifierResponse))
    expect(result.received).toHaveLength(1)
    expect(result.received[0].method).toBe('POST')
    expect(result.received[0].path).toBe('/v1/messages')
    expect(result.received[0].body).toEqual(classifierRequest)
    expect(result.status).toBe(200)
    expect(result.contentType).toContain('application/json')
    expect(JSON.parse(result.text)).toEqual(classifierResponse)
  })

  test('uses provider authentication without forwarding the client credential or proxy trail', async () => {
    const result = await exchange(classifierRequest, Response.json(classifierResponse))
    const headers = result.received[0].headers
    expect(headers.get('x-api-key')).toBe('upstream-test-key')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.get('authorization')).not.toContain('client-rialto-token')
    expect(headers.get('host')).not.toBe('inbound.example.test')
    expect(headers.get('cf-ray')).toBeNull()
  })

  test('preserves native tool definitions and streams instead of converting them to Chat format', async () => {
    const body = {
      ...classifierRequest,
      stream: true,
      tools: [
        {
          name: 'Bash',
          description: 'Run a command',
          input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
        }
      ]
    }
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { ...classifierResponse, content: [] } })}\n\n`,
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"323"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ].join('')
    const result = await exchange(body, new Response(sse, { headers: { 'content-type': 'text/event-stream' } }))
    expect(result.received[0].body).toEqual(body)
    expect(result.status).toBe(200)
    expect(result.contentType).toContain('text/event-stream')
    expect(result.text).toBe(sse)
  })
})
