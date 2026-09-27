/**
 * OpenAITransformer.transformRequestOut — the endpoint-side inbound
 * hook that runs on /v1/chat/completions. Verifies the two shape
 * normalisations that keep OpenAI-compat callers working when the
 * request reaches a strict upstream (codex) that allow-lists
 * top-level params:
 *
 *   - Anthropic-style top-level `system` gets absorbed into a leading
 *     `messages[0]` with role='system', so persona-injected pipelines
 *     don't leak a stray field.
 *   - Top-level `reasoning_effort` scalar becomes nested
 *     `reasoning.effort`, matching the unified shape every downstream
 *     transformer reads.
 */

import { describe, expect, test } from 'bun:test'
import { OpenAITransformer } from '../../src/llms/transformers/openai'
import { OpenAIResponsesTransformer } from '../../src/llms/transformers/openai/endpoint-responses'
import type { TransformerContext, UnifiedChatRequest } from '../../src/schemas/domain'

const t = new OpenAITransformer()
const ctx = {} as TransformerContext

describe('OpenAITransformer.transformRequestOut — system absorption', () => {
  test('string system prepends a system message and drops the top-level field', async () => {
    const out = (await t.transformRequestOut(
      { model: 'gpt-4.1', system: 'You are terse.', messages: [{ role: 'user', content: 'hi' }] },
      ctx
    )) as UnifiedChatRequest & { system?: unknown }
    expect(out.messages).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' }
    ])
    expect(out.system).toBeUndefined()
  })

  test('Anthropic block-array system flattens text blocks', async () => {
    const out = (await t.transformRequestOut(
      {
        model: 'gpt-4.1',
        system: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' }
        ],
        messages: []
      },
      ctx
    )) as UnifiedChatRequest & { system?: unknown }
    expect(out.messages).toEqual([{ role: 'system', content: 'first\n\nsecond' }])
    expect(out.system).toBeUndefined()
  })

  test('skips prepend when messages[0] already has role=system (avoids duplication)', async () => {
    const out = (await t.transformRequestOut(
      {
        model: 'gpt-4.1',
        system: 'ignored persona',
        messages: [
          { role: 'system', content: 'caller-supplied' },
          { role: 'user', content: 'hi' }
        ]
      },
      ctx
    )) as UnifiedChatRequest & { system?: unknown }
    expect(out.messages).toHaveLength(2)
    expect(out.messages[0]).toEqual({ role: 'system', content: 'caller-supplied' })
    expect(out.system).toBeUndefined()
  })

  test('null/empty system is deleted without touching messages', async () => {
    const out = (await t.transformRequestOut(
      { model: 'gpt-4.1', system: '', messages: [{ role: 'user', content: 'x' }] },
      ctx
    )) as UnifiedChatRequest & { system?: unknown }
    expect(out.messages).toEqual([{ role: 'user', content: 'x' }])
    expect(out.system).toBeUndefined()
  })

  test('no system passes through unchanged', async () => {
    const out = (await t.transformRequestOut(
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'x' }] },
      ctx
    )) as UnifiedChatRequest & { system?: unknown }
    expect(out.messages).toEqual([{ role: 'user', content: 'x' }])
    expect(out.system).toBeUndefined()
  })
})

describe('OpenAITransformer.transformRequestOut — reasoning_effort translation', () => {
  test('top-level reasoning_effort becomes nested reasoning.effort', async () => {
    const out = (await t.transformRequestOut(
      { model: 'gpt-5-mini', messages: [], reasoning_effort: 'high' },
      ctx
    )) as UnifiedChatRequest & { reasoning_effort?: string; reasoning?: { effort?: string } }
    expect(out.reasoning).toEqual({ effort: 'high' })
    expect(out.reasoning_effort).toBeUndefined()
  })

  test('preserves an existing reasoning.effort (client intent wins over top-level fallback)', async () => {
    const out = (await t.transformRequestOut(
      { model: 'gpt-5-mini', messages: [], reasoning_effort: 'low', reasoning: { effort: 'high' } },
      ctx
    )) as UnifiedChatRequest & { reasoning_effort?: string; reasoning?: { effort?: string } }
    expect(out.reasoning?.effort).toBe('high')
    expect(out.reasoning_effort).toBeUndefined()
  })

  test('merges into an existing reasoning object without effort', async () => {
    const out = (await t.transformRequestOut(
      { model: 'gpt-5-mini', messages: [], reasoning_effort: 'medium', reasoning: { max_tokens: 100 } },
      ctx
    )) as UnifiedChatRequest & { reasoning?: { effort?: string; max_tokens?: number } }
    expect(out.reasoning).toEqual({ max_tokens: 100, effort: 'medium' })
  })
})

describe('OpenAITransformer.transformRequestIn — Chat effort wire shape', () => {
  const provider = { name: 'openai', api_base_url: 'https://api.openai.com/v1/chat/completions', api_key: 'test' }

  test('restores a client scalar after the unified outbound conversion', async () => {
    const unified = await t.transformRequestOut({ model: 'gpt-5.4', messages: [], reasoning_effort: 'low' }, ctx)
    const sent = await t.transformRequestIn(unified, provider, ctx)
    expect(Reflect.get(sent, 'reasoning_effort')).toBe('low')
    expect(Reflect.has(sent, 'reasoning')).toBe(false)
  })

  test('manual override wins over client scalar', async () => {
    const unified = await t.transformRequestOut({ model: 'gpt-5.4', messages: [], reasoning_effort: 'low' }, ctx)
    const sent = await t.transformRequestIn(unified, { ...provider, modelReasoningEfforts: { 'gpt-5.4': 'high' } }, ctx)
    expect(Reflect.get(sent, 'reasoning_effort')).toBe('high')
    expect(Reflect.has(sent, 'reasoning')).toBe(false)
  })
})

describe('OpenAIResponsesTransformer.transformRequestIn — reasoning summary', () => {
  test('preserves caller summary when effort is absent', async () => {
    const responses = new OpenAIResponsesTransformer()
    const request = await responses.transformRequestOut(
      { model: 'gpt-5.4', input: 'hello', reasoning: { summary: 'auto' } },
      ctx
    )
    const result = await responses.transformRequestIn(request, {
      name: 'openai',
      api_base_url: 'https://api.openai.com/v1/responses',
      api_key: 'test'
    })
    const body = 'body' in result ? result.body : result
    expect(Reflect.get(body, 'reasoning')).toEqual({ effort: undefined, summary: 'auto' })
  })
})

describe('OpenAITransformer.transformRequestOut — passthrough safety', () => {
  test('non-object body returns unchanged', async () => {
    // biome-ignore plugin: intentional non-object input to test the defensive branch
    const out = await t.transformRequestOut(null, ctx)
    expect(out).toBeNull()
  })
})
