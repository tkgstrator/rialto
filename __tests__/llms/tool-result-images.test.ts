/**
 * An image a tool returned, carried from an Anthropic tool_result to each
 * outbound wire format.
 *
 * Claude Code's Read tool answers a screenshot with
 * `tool_result.content = [{ type: 'image', source: { type: 'base64', … } }]`.
 * The unified conversion used to `JSON.stringify` that array, so the
 * upstream received the base64 as prompt text: far past the context window
 * of a Codex model (which fails the response mid-stream), and resent in
 * every later turn of the conversation.
 *
 * The unified tool message now keeps the image as an image part, and each
 * wire format renders it:
 *   - Responses (Codex): `function_call_output.output` is an
 *     `input_text` / `input_image` array — the shape the Codex CLI sends
 *   - Chat Completions:  a tool message takes text only, so the image moves
 *     into a user message after the run of tool messages
 *   - Gemini:            a functionResponse result is JSON, so likewise
 */

import { describe, expect, test } from 'bun:test'
import { AnthropicTransformer } from '../../src/llms/transformers/anthropic'
import { OpenAIResponsesTransformer, OpenAITransformer } from '../../src/llms/transformers/openai'
import { buildRequestBody } from '../../src/llms/utils/gemini-conversion'
import { LIFTED_IMAGE_NOTE, liftToolResultImages } from '../../src/llms/utils/tool-result-images'
import type { RuntimeProvider, TransformerContext, UnifiedChatRequest, UnifiedMessage } from '../../src/schemas/domain'

const ctx = {} as TransformerContext
const provider = { name: 'p', api_base_url: 'https://example.test/v1', api_key: 'k' } as unknown as RuntimeProvider

const PNG = 'iVBORw0KGgoAAAANSUhEUg'
const DATA_URL = `data:image/png;base64,${PNG}`

const screenshot = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }

// A turn in which Claude Code read two files — one screenshot, one text —
// and then said something itself.
const anthropicBody = {
  model: 'm',
  max_tokens: 16,
  messages: [
    { role: 'user', content: 'look at these' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu_img', name: 'Read', input: { file_path: 'shot.png' } },
        { type: 'tool_use', id: 'tu_txt', name: 'Read', input: { file_path: 'notes.txt' } }
      ]
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_img', content: [screenshot] },
        {
          type: 'tool_result',
          tool_use_id: 'tu_txt',
          content: [
            { type: 'text', text: 'line 1' },
            { type: 'text', text: 'line 2' }
          ]
        },
        { type: 'text', text: 'what do you see?' }
      ]
    }
  ]
}

const unified = (): Promise<UnifiedChatRequest> => new AnthropicTransformer().transformRequestOut(anthropicBody, ctx)

// Fresh per call: the outbound hooks reshape the body in place.
const toolMessages = (request: UnifiedChatRequest): UnifiedMessage[] =>
  request.messages.filter((message) => message.role === 'tool')

describe('anthropic-messages → unified', () => {
  test('an image in a tool_result stays an image part, never base64 text', async () => {
    const [image] = toolMessages(await unified())
    expect(image).toMatchObject({
      tool_call_id: 'tu_img',
      content: [{ type: 'image_url', image_url: { url: DATA_URL }, media_type: 'image/png' }]
    })
  })

  test('all-text content collapses to the text itself, not its JSON', async () => {
    const [, text] = toolMessages(await unified())
    expect(text).toMatchObject({ tool_call_id: 'tu_txt', content: 'line 1\nline 2' })
  })

  test('text beside an image is kept as a text part', async () => {
    const request = await new AnthropicTransformer().transformRequestOut(
      {
        model: 'm',
        max_tokens: 16,
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Screenshot', input: {} }] },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'captured' }, screenshot] }
            ]
          }
        ]
      },
      ctx
    )
    expect(toolMessages(request)[0]?.content).toEqual([
      { type: 'text', text: 'captured' },
      { type: 'image_url', image_url: { url: DATA_URL }, media_type: 'image/png' }
    ])
  })

  test('a block that is neither text nor image keeps the JSON it was always sent as', async () => {
    const block = { type: 'search_result', source: 'https://example.test', title: 't', content: [] }
    const request = await new AnthropicTransformer().transformRequestOut(
      {
        model: 'm',
        max_tokens: 16,
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Search', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [block] }] }
        ]
      },
      ctx
    )
    expect(toolMessages(request)[0]?.content).toBe(JSON.stringify(block))
  })
})

describe('openai-responses (Codex) — the image rides inside the function output', () => {
  test('function_call_output.output is an input_image array, and no text carries the base64', async () => {
    const out = await new OpenAIResponsesTransformer().transformRequestIn(await unified(), provider)
    const body = 'body' in out ? out.body : out
    const input = Reflect.get(Object(body), 'input')
    const outputs = Array.isArray(input)
      ? input.filter((item) => Reflect.get(Object(item), 'type') === 'function_call_output')
      : []
    expect(outputs).toEqual([
      { type: 'function_call_output', call_id: 'tu_img', output: [{ type: 'input_image', image_url: DATA_URL }] },
      { type: 'function_call_output', call_id: 'tu_txt', output: 'line 1\nline 2' }
    ])
  })
})

describe('openai-chat — the image moves to a user message after the tool messages', () => {
  test('both tool messages stay adjacent to the assistant turn, then the image, then the user text', async () => {
    const request = await new OpenAITransformer().transformRequestIn(await unified(), provider, ctx)
    expect(request.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
      'user'
    ])
    expect(request.messages[2]).toMatchObject({ tool_call_id: 'tu_img', content: LIFTED_IMAGE_NOTE })
    expect(request.messages[3]).toMatchObject({ tool_call_id: 'tu_txt', content: 'line 1\nline 2' })
    expect(request.messages[4]).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: DATA_URL }, media_type: 'image/png' }]
    })
    expect(request.messages[5]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'what do you see?' }] })
  })
})

describe('gemini — the image moves to a user turn beside the functionResponses', () => {
  test('the functionResponse result is text, and the image is inlineData in a turn of its own', async () => {
    const body = buildRequestBody(await unified())
    const serialised = JSON.stringify(body.contents)
    const responses = body.contents.find((content) => content.parts.some((part) => 'functionResponse' in part))
    expect(JSON.stringify(responses)).not.toContain(PNG)
    expect(JSON.stringify(responses)).toContain(LIFTED_IMAGE_NOTE)
    expect(body.contents).toContainEqual({
      role: 'user',
      parts: [{ inlineData: { mime_type: 'image/png', data: PNG } }]
    })
    // Exactly once: in the inlineData part, nowhere as text.
    expect(serialised.split(PNG).length - 1).toBe(1)
  })
})

describe('liftToolResultImages', () => {
  test('a conversation with no tool images comes back as it was', () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 't', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: DATA_URL }, media_type: 'image/png' }] }
    ]
    const lifted = liftToolResultImages(messages)
    expect(lifted).toEqual(messages)
    // The same objects, not copies: nothing was rewritten.
    expect(lifted.every((message, i) => message === messages[i])).toBe(true)
  })

  test('a tool message that ends the conversation still has its image placed after it', () => {
    const lifted = liftToolResultImages([
      {
        role: 'tool',
        tool_call_id: 't',
        content: [{ type: 'image_url', image_url: { url: DATA_URL }, media_type: 'image/png' }]
      }
    ])
    expect(lifted.map((message) => message.role)).toEqual(['tool', 'user'])
  })

  test('images from separate assistant turns are not merged across them', () => {
    const image = { type: 'image_url' as const, image_url: { url: DATA_URL }, media_type: 'image/png' }
    const lifted = liftToolResultImages([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'a', type: 'function', function: { name: 'R', arguments: '{}' } }]
      },
      { role: 'tool', tool_call_id: 'a', content: [image] },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'b', type: 'function', function: { name: 'R', arguments: '{}' } }]
      },
      { role: 'tool', tool_call_id: 'b', content: [image] }
    ])
    expect(lifted.map((message) => message.role)).toEqual(['assistant', 'tool', 'user', 'assistant', 'tool', 'user'])
  })
})
