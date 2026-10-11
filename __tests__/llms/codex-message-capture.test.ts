import { describe, expect, test } from 'bun:test'
import pino from 'pino'
import { redactToolArguments } from '../../src/api/v1/redact'
import { runPipeline } from '../../src/llms/pipeline'
import { ProviderRegistry } from '../../src/llms/registry/provider'
import { TransformerRegistry } from '../../src/llms/registry/transformer'
import { AnthropicTransformer } from '../../src/llms/transformers/anthropic'
import { CodexOauthTransformer, OpenAIResponsesTransformer } from '../../src/llms/transformers/openai'
import { aggregateAnthropicSseToJson } from '../../src/llms/utils/sse-aggregate'
import type { MessageRecord } from '../../src/schemas/domain'

// Exercise the real OAuth request shaping without credentials, refreshes or a DB.
class FixtureCodexTransformer extends CodexOauthTransformer {
  protected async resolveSubscriptionAuth() {
    return { token: 'fixture-codex-token', accountId: 'fixture-account' }
  }
}

const prompt = 'RIALTO_AGENT_CAPTURE_TEST 日本語の全文を保持する。'.repeat(140)
const input = { prompt, description: 'Capture test', subagent_type: 'general-purpose', model: 'haiku' }
const userContent = [{ type: 'text', text: 'Launch a harmless test agent.' }]

function codexEvents(name: string) {
  const argumentsJson = JSON.stringify(input)
  const item = { type: 'function_call', id: 'fc_test', call_id: 'call_test', name, arguments: '' }
  const response = { id: 'resp_test', model: 'gpt-5.5', output: [], usage: null, error: null, incomplete_details: null }
  return [
    { type: 'response.created', response: { ...response, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item },
    {
      type: 'response.function_call_arguments.delta',
      item_id: item.id,
      output_index: 0,
      delta: argumentsJson.slice(0, 51)
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: item.id,
      output_index: 0,
      delta: argumentsJson.slice(51)
    },
    {
      type: 'response.completed',
      response: { ...response, status: 'completed', output: [{ ...item, arguments: argumentsJson }] }
    }
  ]
}

const permissionSchema = {
  type: 'object',
  properties: { permission: { type: 'string', enum: ['allow', 'deny'] } },
  required: ['permission'],
  additionalProperties: false
}

function classifierEvents() {
  const item = { id: 'msg_permission', type: 'message', role: 'assistant', content: [] }
  return [
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_text.delta', output_index: 0, delta: '{"permission":"deny"}' },
    { type: 'response.completed', response: { id: 'resp_permission', model: 'gpt-5.5', output: [item] } }
  ]
}

async function exchange(
  name: string,
  options: { persist?: boolean; redact?: boolean; failArchive?: boolean; structured?: boolean } = {}
) {
  const records: MessageRecord[] = []
  const logs: string[] = []
  const sent: unknown[] = []
  const log = pino({ level: 'trace' }, { write: (line: string) => logs.push(line) })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      sent.push(await request.json())
      const text = (options.structured ? classifierEvents() : codexEvents(name))
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join('')
      // The real backend can label an SSE body as JSON; OAuth must correct it.
      return new Response(text, { headers: { 'content-type': 'application/json' } })
    }
  })
  try {
    const transformer = new AnthropicTransformer()
    const registry = new TransformerRegistry(log)
    registry.registerMany([transformer, new OpenAIResponsesTransformer(), new FixtureCodexTransformer()])
    const providers = new ProviderRegistry(registry, log)
    providers.registerFromConfig([
      {
        name: 'codex',
        api_style: 'openai_responses',
        auth_mode: 'subscription',
        api_base_url: server.url.toString(),
        api_key: 'oauth',
        models: ['gpt-5.5']
      }
    ])
    const provider = providers.get('codex')
    if (provider === undefined) throw new Error('Codex fixture provider missing')
    const body = {
      model: 'gpt-5.5',
      max_tokens: 1024,
      stream: options.structured !== true,
      ...(options.structured ? { output_config: { format: { type: 'json_schema', schema: permissionSchema } } } : {}),
      system: 'Keep the supplied agent task intact.',
      messages: [{ role: 'user', content: userContent }],
      tools: [
        {
          name,
          description: 'Test agent',
          input_schema: { type: 'object', properties: { prompt: { type: 'string' } } }
        }
      ]
    }
    const headers = { 'x-claude-code-session-id': 'codex-capture-session' }
    const response = await runPipeline(
      {
        body,
        headers,
        provider,
        transformer,
        context: { req: { body, headers, url: '/v1/messages', model: body.model } }
      },
      {
        log,
        recordMessages:
          options.persist === false
            ? undefined
            : async (entries) => {
                if (options.failArchive) throw new Error('PRIVATE_ARCHIVE_ERROR')
                records.push(
                  ...entries.map((entry) => ({
                    ...entry,
                    content: options.redact ? redactToolArguments(entry.content) : entry.content
                  }))
                )
              }
      }
    )
    const text = await response.text()
    // Archive completion is deliberately asynchronous, independent of client relay.
    for (const _ of Array.from({ length: 40 })) {
      if (
        logs.some((line) => line.includes('agent_call_detected')) ||
        records.some((record) => record.role === 'assistant')
      )
        break
      await Bun.sleep(5)
    }
    await Bun.sleep(5)
    return { sent, records, logs: logs.map((line) => JSON.parse(line)), text, status: response.status }
  } finally {
    await server.stop(true)
  }
}

describe('Codex message capture at the client boundary', () => {
  for (const name of ['Agent', 'Task']) {
    test(`archives the original user turn and complete ${name} arguments after Responses conversion`, async () => {
      const result = await exchange(name)
      expect(result.status).toBe(200)
      expect(result.sent).toEqual([expect.objectContaining({ input: expect.any(Array), stream: true, store: false })])
      expect(result.sent[0]).not.toHaveProperty('messages')
      expect(result.records).toEqual([
        { sessionId: 'codex-capture-session', role: 'user', content: userContent },
        {
          sessionId: 'codex-capture-session',
          role: 'assistant',
          content: [
            expect.objectContaining({
              type: 'tool_use',
              name,
              input,
              agent_call: { prompt_present: true, subagent_type_present: true, model_present: true }
            })
          ]
        }
      ])
      expect(result.logs).toEqual(
        expect.arrayContaining([expect.objectContaining({ event: 'agent_call_detected', toolName: name })])
      )
      expect(JSON.stringify(result.logs)).not.toContain(prompt)
      const blocking = await aggregateAnthropicSseToJson(new Response(result.text))
      expect(blocking.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'tool_use', name, input })])
      )
    })
  }

  test('preserves permission JSON schema through OAuth shaping and a blocking response', async () => {
    const result = await exchange('Agent', { structured: true })
    expect(result.sent).toEqual([
      expect.objectContaining({
        text: {
          verbosity: 'low',
          format: { type: 'json_schema', name: 'anthropic_output', schema: permissionSchema, strict: true }
        }
      })
    ])
    const message = await aggregateAnthropicSseToJson(new Response(result.text))
    expect(message.content).toEqual([{ type: 'text', text: '{"permission":"deny"}' }])
    expect(result.records[1].content).toEqual(message.content)
    expect(result.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'classifier_diagnostic',
          phase: 'upstream_request',
          structuredOutputRequested: true,
          structuredOutputForwarded: true
        })
      ])
    )
    expect(result.logs.some((line) => line.event === 'agent_call_detected')).toBe(false)
  })

  test('redacts the archive without changing the live Agent arguments or structural detection', async () => {
    const result = await exchange('Agent', { redact: true })
    expect(result.records[1].content).toEqual([
      expect.objectContaining({
        input: '[redacted]',
        agent_call: { prompt_present: true, subagent_type_present: true, model_present: true }
      })
    ])
    expect((await aggregateAnthropicSseToJson(new Response(result.text))).content).toEqual(
      expect.arrayContaining([expect.objectContaining({ input })])
    )
  })

  test('detects calls with persistence disabled', async () => {
    const result = await exchange('Agent', { persist: false })
    expect(result.records).toEqual([])
    expect(result.logs).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'agent_call_detected' })]))
  })

  test('reports archive failures without leaking errors or breaking the client response', async () => {
    const result = await exchange('Agent', { failArchive: true })
    expect(result.status).toBe(200)
    expect(result.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'message_capture_failed', phase: 'user' }),
        expect.objectContaining({ event: 'message_capture_failed', phase: 'assistant' })
      ])
    )
    expect(JSON.stringify(result.logs)).not.toContain('PRIVATE_ARCHIVE_ERROR')
    expect((await aggregateAnthropicSseToJson(new Response(result.text))).content).toEqual(
      expect.arrayContaining([expect.objectContaining({ input })])
    )
  })
})
