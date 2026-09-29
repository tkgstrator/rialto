/**
 * The request Rialto sends the Codex backend is the one Codex CLI 0.158.0
 * sends (captured from `codex exec` against a local server), whatever wire
 * format the caller spoke — plus the encrypted reasoning the CLI hands
 * back each turn, carried through a client's thinking-block signature.
 *
 * What started this: a Chat Completions caller with "Answer in JSON." as
 * its system prompt and `response_format: json_object` was refused by
 * Codex with 400 "Response input messages must contain the word 'json'".
 * The system prompt had been lifted into `instructions`, which that check
 * does not read; the CLI sends a caller's instructions as a developer
 * message in `input`.
 */

import { describe, expect, test } from 'bun:test'
import { AnthropicTransformer } from '../../../src/llms/transformers/anthropic'
import { keepSignedBlock } from '../../../src/llms/transformers/anthropic/claude-code-oauth'
import type { OauthCredentials } from '../../../src/llms/transformers/oauth-base'
import { OpenAIResponsesTransformer } from '../../../src/llms/transformers/openai'
import { NEUTRAL_INSTRUCTIONS } from '../../../src/llms/transformers/openai/codex/request-shape'
import { CodexOauthTransformer } from '../../../src/llms/transformers/openai/codex-oauth'
import { codexAccountTag, openCodexReasoning } from '../../../src/llms/utils/codex-reasoning'
import { buildRequestBody } from '../../../src/llms/utils/gemini-request'
import { aggregateAnthropicSseToJson } from '../../../src/llms/utils/sse-aggregate'
import type { RuntimeProvider, TransformerContext, UnifiedChatRequest } from '../../../src/schemas/domain'

type Bag = Record<string, unknown>

const codexProvider: RuntimeProvider = {
  name: 'codex',
  api_base_url: 'https://chatgpt.com/backend-api/codex',
  api_key: 'oauth'
}

// Resolves the account the way the real one does: stamping it on the
// request, where the reasoning seal and unseal read it.
class StubbedCodex extends CodexOauthTransformer {
  private readonly account: string
  constructor(account: string) {
    super()
    this.account = account
  }
  protected async resolveSubscriptionAuth(
    _provider?: unknown,
    _session?: unknown,
    _kind?: unknown,
    _request?: unknown,
    context?: TransformerContext
  ): Promise<OauthCredentials> {
    if (context?.req !== undefined) context.req.subAccountId = this.account
    return { token: 'codex-access-token', accountId: 'acct_1' }
  }
}

const contextFor = (surface: string, body: Bag, headers: Record<string, string> = {}): TransformerContext =>
  ({
    req: { headers, body, url: '/v1', surface, provider: 'codex', isSubagent: false }
  }) as unknown as TransformerContext

const bodyOf = (result: unknown): Bag => {
  const r = Object(result)
  return 'body' in r ? Object(r.body) : r
}

type Sent = { body: Bag; headers: Record<string, string> }

// The provider chain a Codex subscription runs: openai-responses, then
// codex-oauth.
async function toCodex(unified: Bag, context: TransformerContext, account = 'sub_a'): Promise<Sent> {
  const responses = await new OpenAIResponsesTransformer().transformRequestIn(
    unified as unknown as UnifiedChatRequest,
    codexProvider
  )
  const hook = await new StubbedCodex(account).transformRequestIn(
    bodyOf(responses) as unknown as UnifiedChatRequest,
    codexProvider,
    context
  )
  return { body: bodyOf(hook), headers: Object(hook.config?.headers) }
}

async function anthropicToCodex(anthropic: Bag, account = 'sub_a'): Promise<Sent> {
  const unified = await new AnthropicTransformer().transformRequestOut(
    anthropic,
    contextFor('anthropic-messages', anthropic)
  )
  return toCodex(unified as unknown as Bag, contextFor('anthropic-messages', anthropic), account)
}

// Every top-level field Codex CLI 0.158.0 sends on the classic shape.
const CLI_FIELDS = new Set([
  'model',
  'instructions',
  'input',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'reasoning',
  'store',
  'stream',
  'include',
  'service_tier',
  'prompt_cache_key',
  'text',
  'client_metadata'
])

describe('a Chat Completions caller', () => {
  const unified = {
    model: 'gpt-5.6-terra',
    messages: [
      { role: 'system', content: 'Answer in JSON.' },
      { role: 'user', content: 'list three colours' }
    ],
    response_format: { type: 'json_object' },
    max_tokens: 100,
    temperature: 0.2,
    stream_options: { include_usage: true },
    metadata: { team: 'a' }
  }

  test('its system prompt is the developer message, where the json_object check finds the word', async () => {
    const { body } = await toCodex(structuredClone(unified), contextFor('openai-chat', {}))
    expect(body.instructions).toBe(NEUTRAL_INSTRUCTIONS)
    expect(body.input).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Answer in JSON.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list three colours' }] }
    ])
    expect(body.text).toEqual({ verbosity: 'low', format: { type: 'json_object' } })
  })

  test('only the fields the CLI sends go upstream, with its values', async () => {
    const { body } = await toCodex(structuredClone(unified), contextFor('openai-chat', {}))
    expect(Object.keys(body).filter((key) => !CLI_FIELDS.has(key))).toEqual([])
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.include).toEqual(['reasoning.encrypted_content'])
    expect(body.parallel_tool_calls).toBe(true)
    // No tools, so no tool_choice to state.
    expect('tool_choice' in body).toBe(false)
  })

  test('a caller that turned parallel tool calls off keeps them off', async () => {
    const { body } = await toCodex(structuredClone(unified), contextFor('openai-chat', { parallel_tool_calls: false }))
    expect(body.parallel_tool_calls).toBe(false)
  })
})

describe('an Anthropic caller', () => {
  const anthropic = {
    model: 'gpt-5.6-terra',
    max_tokens: 1024,
    system: [
      { type: 'text', text: 'You are Claude Code.' },
      { type: 'text', text: 'Be careful.' }
    ],
    tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'user', content: 'look at a.ts' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.ts' } }
        ]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'export {}' }] }
    ]
  }

  test('its system blocks become one developer message, and no system item is left', async () => {
    const { body } = await anthropicToCodex(structuredClone(anthropic))
    const input = body.input as Bag[]
    const developer = input.filter((item) => item.role === 'developer')
    expect(developer).toHaveLength(1)
    expect(input[0]).toBe(developer[0])
    expect(JSON.stringify(developer[0].content)).toContain('You are Claude Code.')
    expect(JSON.stringify(developer[0].content)).toContain('Be careful.')
    expect(input.some((item) => item.role === 'system')).toBe(false)
  })

  test('what a turn said before calling a tool is kept, ahead of the call', async () => {
    const { body } = await anthropicToCodex(structuredClone(anthropic))
    const input = body.input as Bag[]
    const call = input.findIndex((item) => item.type === 'function_call')
    expect(input[call - 1]).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Let me look.' }]
    })
  })

  test("tools as the CLI states them, and tool_choice 'auto'", async () => {
    const { body } = await anthropicToCodex(structuredClone(anthropic))
    expect((body.tools as Bag[])[0]).toMatchObject({ type: 'function', name: 'Read', strict: false })
    expect(body.tool_choice).toBe('auto')
  })

  test('disable_parallel_tool_use turns parallel tool calls off', async () => {
    const choice = { ...structuredClone(anthropic), tool_choice: { type: 'auto', disable_parallel_tool_use: true } }
    const { body } = await anthropicToCodex(choice)
    expect(body.parallel_tool_calls).toBe(false)
  })
})

describe('a Responses caller (the Codex CLI)', () => {
  const responses = (reasoning: Bag): Bag => ({
    model: 'gpt-5.5',
    instructions: 'You are Codex, the base prompt.',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev instructions' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
    ],
    reasoning,
    text: { verbosity: 'medium' },
    include: ['reasoning.encrypted_content'],
    service_tier: 'priority',
    parallel_tool_calls: false
  })

  async function send(inbound: Bag): Promise<Sent> {
    const context = contextFor('openai-responses', inbound)
    const unified = await new OpenAIResponsesTransformer().transformRequestOut(structuredClone(inbound), context)
    return toCodex(unified as unknown as Bag, context)
  }

  test('keeps its own instructions, developer message, and the options it chose', async () => {
    const { body } = await send(responses({ effort: 'high', summary: 'auto' }))
    expect(body.instructions).toBe('You are Codex, the base prompt.')
    expect((body.input as Bag[])[0]).toEqual({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'dev instructions' }]
    })
    expect(body.reasoning).toEqual({ effort: 'high', summary: 'auto' })
    expect(body.text).toEqual({ verbosity: 'medium' })
    expect(body.include).toEqual(['reasoning.encrypted_content'])
    expect(body.service_tier).toBe('priority')
    expect(body.parallel_tool_calls).toBe(false)
  })

  test('a summary is sent only when the caller asked for one', async () => {
    const { body } = await send(responses({ effort: 'high' }))
    expect(body.reasoning).toEqual({ effort: 'high' })
  })
})

describe('the markers Codex CLI identifies itself with', () => {
  const unified = { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], reasoning: { effort: 'medium' } }

  test('headers name the carried session as the thread, and describe the turn', async () => {
    const { body, headers } = await toCodex(
      structuredClone(unified),
      contextFor('anthropic-messages', {}, { 'x-claude-code-session-id': 'sess-1' })
    )
    expect(headers.originator).toBe('codex_exec')
    expect(headers['user-agent']).toMatch(/^codex_exec\/\S+ \(.+; \S+\) unknown \(codex_exec; \S+\)$/)
    expect(headers['session-id']).toBe('sess-1')
    expect(headers['thread-id']).toBe('sess-1')
    expect(headers['x-client-request-id']).toBe('sess-1')
    expect(headers['x-codex-window-id']).toBe('sess-1:0')
    expect(headers['x-codex-beta-features']).toBe('remote_compaction_v2')
    expect(headers['chatgpt-account-id']).toBe('acct_1')
    expect('session_id' in headers || 'thread_id' in headers).toBe(false)

    const metadata = JSON.parse(headers['x-codex-turn-metadata'])
    expect(Object.keys(metadata)).toEqual([
      'installation_id',
      'session_id',
      'thread_id',
      'agent_name',
      'turn_id',
      'window_id',
      'window_number',
      'context_window_id',
      'request_kind',
      'root_turn_id',
      'thread_source',
      'turn_trigger',
      'sandbox',
      'sandbox_mode',
      'auto_review_enabled',
      'node_repl_auto_review_required',
      'node_repl_disabled',
      'turn_started_at_unix_ms',
      'analytics_enabled',
      'model',
      'reasoning_effort'
    ])
    expect(metadata).toMatchObject({ thread_id: 'sess-1', model: 'gpt-5.5', reasoning_effort: 'medium' })

    expect(body.client_metadata).toMatchObject({
      session_id: 'sess-1',
      thread_id: 'sess-1',
      turn_id: metadata.turn_id,
      root_turn_id: metadata.turn_id,
      'x-codex-installation-id': metadata.installation_id,
      'x-codex-window-id': 'sess-1:0',
      'x-codex-turn-metadata': headers['x-codex-turn-metadata']
    })
  })

  test('one account keeps one installation id; another account has its own', async () => {
    const context = (): TransformerContext => contextFor('anthropic-messages', {})
    const id = async (account: string): Promise<unknown> =>
      JSON.parse((await toCodex(structuredClone(unified), context(), account)).headers['x-codex-turn-metadata'])
        .installation_id
    expect(await id('sub_a')).toBe(await id('sub_a'))
    expect(await id('sub_a')).not.toBe(await id('sub_b'))
  })
})

// ─── Encrypted reasoning, there and back ──────────────────────────────

const sse = (events: Bag[]): Response =>
  new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  })

const completed = { type: 'response.completed', response: { id: 'resp_1', output: [{ type: 'message' }] } }

// A Codex reply, through the provider chain back to an Anthropic caller.
async function anthropicReply(events: Bag[], context: TransformerContext): Promise<Bag> {
  const chat = await new OpenAIResponsesTransformer().transformResponseOut(sse(events), context)
  const anthropic = await new AnthropicTransformer().transformResponseIn(chat, context)
  return aggregateAnthropicSseToJson(anthropic)
}

const replyContext = (account: string | undefined): TransformerContext =>
  ({
    req: { headers: {}, body: {}, url: '/v1/messages', provider: 'codex', subAccountId: account, isSubagent: false }
  }) as unknown as TransformerContext

describe('encrypted reasoning', () => {
  const reasoningThenText = [
    { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning' } },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'ENC-1' }
    },
    { type: 'response.output_item.added', output_index: 1, item: { id: 'msg_1', type: 'message', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, delta: 'done' },
    completed
  ]

  test('with no summary, still reaches the client as a signed thinking block', async () => {
    const reply = await anthropicReply(reasoningThenText, replyContext('sub_a'))
    const [thinking, text] = reply.content as Bag[]
    expect(thinking).toMatchObject({ type: 'thinking', thinking: '' })
    expect(text).toMatchObject({ type: 'text', text: 'done' })
    expect(openCodexReasoning(String(thinking.signature))).toEqual({
      provider: 'codex',
      account: codexAccountTag('sub_a'),
      id: 'rs_1',
      encryptedContent: 'ENC-1'
    })
  })

  test('summary parts share one block, signed once', async () => {
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning' } },
      { type: 'response.reasoning_summary_part.added', item_id: 'rs_1', summary_index: 0 },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'first' },
      { type: 'response.reasoning_summary_part.done', item_id: 'rs_1', summary_index: 0, part: {} },
      { type: 'response.reasoning_summary_part.added', item_id: 'rs_1', summary_index: 1 },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'second' },
      { type: 'response.reasoning_summary_part.done', item_id: 'rs_1', summary_index: 1, part: {} },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'rs_1',
          type: 'reasoning',
          summary: [{ text: 'first' }, { text: 'second' }],
          encrypted_content: 'ENC-1'
        }
      },
      completed
    ]
    const blocks = (await anthropicReply(events, replyContext('sub_a'))).content as Bag[]
    const thinking = blocks.filter((block) => block.type === 'thinking')
    expect(thinking).toHaveLength(1)
    expect(thinking[0].thinking).toBe('first\n\nsecond')
    expect(openCodexReasoning(String(thinking[0].signature))?.encryptedContent).toBe('ENC-1')
  })

  test('an API-key reply is not sealed: the item id signs a block that has text, and nothing else is signed', async () => {
    const withText = structuredClone(reasoningThenText)
    Object.assign(withText[1].item as Bag, { summary: [{ text: 'why' }], encrypted_content: undefined })
    withText.splice(1, 0, { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'why' })
    const signed = (await anthropicReply(withText, replyContext(undefined))).content as Bag[]
    expect(signed[0]).toMatchObject({ type: 'thinking', thinking: 'why', signature: 'rs_1' })

    const bare = structuredClone(reasoningThenText)
    Object.assign(bare[1].item as Bag, { encrypted_content: undefined })
    const blocks = (await anthropicReply(bare, replyContext(undefined))).content as Bag[]
    expect(blocks.map((block) => block.type)).toEqual(['text'])
  })

  test("goes back to the account that produced it, ahead of that turn's output", async () => {
    const reply = await anthropicReply(reasoningThenText, replyContext('sub_a'))
    const next = {
      model: 'gpt-5.5',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: reply.content },
        { role: 'user', content: 'second question' }
      ]
    }
    const same = (await anthropicToCodex(structuredClone(next), 'sub_a')).body.input as Bag[]
    const at = same.findIndex((item) => item.type === 'reasoning')
    expect(same[at]).toEqual({ type: 'reasoning', id: 'rs_1', summary: [], content: null, encrypted_content: 'ENC-1' })
    expect(same[at + 1]).toMatchObject({ type: 'message', role: 'assistant' })

    // Another account cannot decrypt it; the turn goes without.
    const other = (await anthropicToCodex(structuredClone(next), 'sub_b')).body.input as Bag[]
    expect(other.some((item) => item.type === 'reasoning')).toBe(false)
  })

  test('never reaches another provider, Anthropic or Gemini', async () => {
    const reply = await anthropicReply(reasoningThenText, replyContext('sub_a'))
    const thinking = (reply.content as Bag[])[0]
    const assistant = {
      role: 'assistant',
      content: 'done',
      thinking: { content: '', signature: String(thinking.signature) }
    }
    const messages = [{ role: 'user', content: 'q' }, assistant, { role: 'user', content: 'next' }]

    const openai = await new OpenAIResponsesTransformer().transformRequestIn(
      { model: 'gpt-5.5', messages } as unknown as UnifiedChatRequest,
      { name: 'openai', api_base_url: 'https://api.openai.com/v1/responses', api_key: 'sk' }
    )
    expect(JSON.stringify(bodyOf(openai))).not.toContain('rialto_codex.')
    expect(keepSignedBlock(thinking)).toBe(false)
    const gemini = buildRequestBody({ model: 'gemini-3', messages } as unknown as UnifiedChatRequest)
    expect(JSON.stringify(gemini)).not.toContain('rialto_codex.')
  })
})

describe('parallel tool calls', () => {
  test('two calls in one reply reach an Anthropic caller as two tool_use blocks', async () => {
    const call = (n: number, id: string, args: string): Bag[] => [
      {
        type: 'response.output_item.added',
        output_index: n,
        item: { id, type: 'function_call', call_id: `call_${n}`, name: 'Read' }
      },
      { type: 'response.function_call_arguments.delta', item_id: id, output_index: n, delta: args }
    ]
    const events = [
      ...call(0, 'fc_a', '{"file_path":"a.ts"}'),
      ...call(1, 'fc_b', '{"file_path":"b.ts"}'),
      { type: 'response.completed', response: { id: 'resp_1', output: [{ type: 'function_call' }] } }
    ]
    const blocks = (await anthropicReply(events, replyContext('sub_a'))).content as Bag[]
    expect(blocks.map((block) => [block.type, block.id, block.input])).toEqual([
      ['tool_use', 'call_0', { file_path: 'a.ts' }],
      ['tool_use', 'call_1', { file_path: 'b.ts' }]
    ])
  })
})
