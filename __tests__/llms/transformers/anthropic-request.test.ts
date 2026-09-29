/**
 * Unit tests for the Anthropic wire → unified tool conversion.
 *
 * Regression guard: prior to the AnthropicToolDefSchema split every tool
 * required description + input_schema, which rejected Anthropic's
 * server-side tools (web_search / computer / bash / text_editor /
 * code_execution). The rejection only surfaced when routing to a
 * non-Anthropic provider, because shouldBypass skips transformRequestOut
 * on the Anthropic → Anthropic path.
 */

import { describe, expect, test } from 'bun:test'
import { AnthropicTransformer } from '../../../src/llms/transformers/anthropic/endpoint'
import { convertAnthropicToolsToUnified } from '../../../src/llms/transformers/anthropic/request'
import { AnthropicIncomingRequestSchema } from '../../../src/schemas/wire/anthropic/messages'

const baseRequest = {
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'hi' }]
}

describe('AnthropicToolDefSchema', () => {
  test('accepts web_search server tool (type + name only)', () => {
    const parsed = AnthropicIncomingRequestSchema.parse({
      ...baseRequest,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }]
    })
    expect(parsed.tools).toHaveLength(1)
  })

  test('accepts server tool with tool-specific extras (max_uses, display_width_px)', () => {
    const parsed = AnthropicIncomingRequestSchema.parse({
      ...baseRequest,
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
        { type: 'computer_20250124', name: 'computer', display_width_px: 1024, display_height_px: 768 }
      ]
    })
    expect(parsed.tools).toHaveLength(2)
  })

  test('accepts every Anthropic-hosted tool type prefix', () => {
    const kinds = [
      'web_search_20250305',
      'computer_20250124',
      'bash_20250124',
      'text_editor_20250124',
      'code_execution_20250522',
      'advisor_20260301'
    ]
    for (const type of kinds) {
      const parsed = AnthropicIncomingRequestSchema.parse({
        ...baseRequest,
        tools: [{ type, name: type.split('_')[0] }]
      })
      expect(parsed.tools[0]?.name).toBe(type.split('_')[0])
    }
  })

  test('accepts custom tool without explicit type', () => {
    const parsed = AnthropicIncomingRequestSchema.parse({
      ...baseRequest,
      tools: [
        {
          name: 'lookup',
          description: 'looks something up',
          input_schema: { type: 'object', properties: {} }
        }
      ]
    })
    expect(parsed.tools).toHaveLength(1)
  })

  test('accepts custom tool with explicit type: "custom"', () => {
    const parsed = AnthropicIncomingRequestSchema.parse({
      ...baseRequest,
      tools: [
        {
          type: 'custom',
          name: 'lookup',
          description: 'looks something up',
          input_schema: { type: 'object', properties: {} }
        }
      ]
    })
    expect(parsed.tools).toHaveLength(1)
  })

  test('rejects custom tool missing description (regression guard)', () => {
    const result = AnthropicIncomingRequestSchema.safeParse({
      ...baseRequest,
      tools: [
        {
          name: 'lookup',
          input_schema: { type: 'object', properties: {} }
        }
      ]
    })
    expect(result.success).toBe(false)
  })

  test('rejects unknown `type` that is not a known server-tool prefix nor "custom"', () => {
    const result = AnthropicIncomingRequestSchema.safeParse({
      ...baseRequest,
      tools: [{ type: 'foo_bar_20250101', name: 'foo' }]
    })
    expect(result.success).toBe(false)
  })
})

describe('convertAnthropicToolsToUnified', () => {
  test('maps a server tool to a unified function tool keyed by name', () => {
    const parsed = AnthropicIncomingRequestSchema.parse({
      ...baseRequest,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }]
    })
    const unified = convertAnthropicToolsToUnified(parsed.tools)
    expect(unified).toHaveLength(1)
    expect(unified[0]?.function.name).toBe('web_search')
    // Downstream (e.g. openai-responses/remapTools) matches by name.
    expect(unified[0]?.function.description.length).toBeGreaterThan(0)
    expect(unified[0]?.function.parameters.type).toBe('object')
  })

  test('preserves a custom tool description and input_schema unchanged', () => {
    const parsed = AnthropicIncomingRequestSchema.parse({
      ...baseRequest,
      tools: [
        {
          name: 'lookup',
          description: 'looks something up',
          input_schema: { type: 'object', properties: { q: { type: 'string' } } }
        }
      ]
    })
    const unified = convertAnthropicToolsToUnified(parsed.tools)
    expect(unified[0]?.function.description).toBe('looks something up')
    expect(unified[0]?.function.parameters.properties).toEqual({ q: { type: 'string' } })
  })

  test('handles mixed server + custom tools in one request', () => {
    const parsed = AnthropicIncomingRequestSchema.parse({
      ...baseRequest,
      tools: [
        { type: 'web_search_20250305', name: 'web_search' },
        {
          name: 'lookup',
          description: 'looks something up',
          input_schema: { type: 'object', properties: {} }
        }
      ]
    })
    const unified = convertAnthropicToolsToUnified(parsed.tools)
    expect(unified.map((t) => t.function.name)).toEqual(['web_search', 'lookup'])
  })

  // The advisor only runs on Anthropic, and this conversion only runs for
  // other vendors: carried as a function it would be called and left
  // unanswered, so it is dropped while the rest of the tools stay.
  test('drops the advisor tool and keeps the others', () => {
    const parsed = AnthropicIncomingRequestSchema.parse({
      ...baseRequest,
      tools: [
        { type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-5-5', max_uses: 3 },
        {
          name: 'lookup',
          description: 'looks something up',
          input_schema: { type: 'object', properties: {} }
        }
      ]
    })
    const unified = convertAnthropicToolsToUnified(parsed.tools)
    expect(unified.map((t) => t.function.name)).toEqual(['lookup'])
  })
})

describe('AnthropicTransformer.transformRequestOut', () => {
  // An advisor-only tool list converts to nothing; `tools` must then be
  // absent rather than `[]`, which OpenAI rejects.
  test('omits tools when the advisor was the only one', async () => {
    const unified = await new AnthropicTransformer().transformRequestOut(
      { ...baseRequest, tools: [{ type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-5-5' }] },
      {}
    )
    expect(unified.tools).toBeUndefined()
  })
})
