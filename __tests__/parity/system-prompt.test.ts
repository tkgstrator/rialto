/**
 * Parity matrix — the "system prompt" row.
 *
 * Each surface puts the system prompt somewhere different:
 *   - anthropic-messages : top-level `system`, a string or a block array
 *   - openai-chat        : `messages[0].role === 'system'`
 *   - openai-responses   : top-level `instructions`
 *   - gemini-generate    : top-level `systemInstruction`
 *
 * On the conversion path it only reaches the downstream provider once it
 * has been folded into a unified `role: 'system'` message. Without that
 * the system prompt **disappears silently** — worse than an error,
 * because nothing complains.
 */

import { describe, expect, test } from 'bun:test'
import { AnthropicTransformer } from '../../src/llms/transformers/anthropic'
import { GeminiTransformer } from '../../src/llms/transformers/gemini'
import { OpenAIResponsesTransformer, OpenAITransformer } from '../../src/llms/transformers/openai'
import type { TransformerContext } from '../../src/schemas/domain'

const ctx = {} as TransformerContext

const systemContentOf = (messages: unknown): unknown => {
  if (!Array.isArray(messages)) return undefined
  const first = messages.find((m) => Reflect.get(Object(m), 'role') === 'system')
  return first === undefined ? undefined : Reflect.get(Object(first), 'content')
}

describe('anthropic-messages — supported', () => {
  test('a string system becomes the leading system message', async () => {
    const unified = await new AnthropicTransformer().transformRequestOut(
      { model: 'm', max_tokens: 16, system: 'You are terse.', messages: [{ role: 'user', content: 'hi' }] },
      ctx
    )
    expect(systemContentOf(unified.messages)).toBe('You are terse.')
  })

  test('a block-array system is kept together with its cache_control', async () => {
    // Dropping cache_control loses the marker Claude Code attaches for
    // prefix caching, and the bill jumps. Picking out just the text is
    // not enough here.
    const unified = await new AnthropicTransformer().transformRequestOut(
      {
        model: 'm',
        max_tokens: 16,
        system: [
          { type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'Be terse.' }
        ],
        messages: [{ role: 'user', content: 'hi' }]
      },
      ctx
    )
    expect(systemContentOf(unified.messages)).toEqual([
      { type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Be terse.', cache_control: undefined }
    ])
  })
})

describe('openai-chat — supported', () => {
  test('a native system message passes straight through', async () => {
    const unified = await new OpenAITransformer().transformRequestOut(
      {
        model: 'm',
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'hi' }
        ]
      },
      ctx
    )
    expect(systemContentOf(unified.messages)).toBe('You are terse.')
  })

  // Absorbing an Anthropic-style top-level `system` — defensive absorption
  // of an Anthropic-shape body that reached this transformer via passthrough
  // — is covered by "system absorption" in
  // __tests__/llms/openai-transformer-request-out.test.ts.
})

describe('openai-responses — supported', () => {
  test('instructions becomes the leading system message', async () => {
    const unified = await new OpenAIResponsesTransformer().transformRequestOut(
      { model: 'm', instructions: 'You are terse.', input: 'hi' },
      ctx
    )
    expect(systemContentOf(unified.messages)).toBe('You are terse.')
    // The Responses-specific key must not leak downstream.
    expect(Reflect.get(unified, 'instructions')).toBeUndefined()
  })
})

describe('gemini-generate — supported', () => {
  test('systemInstruction becomes the leading system message', async () => {
    const unified = await new GeminiTransformer().transformRequestOut(
      {
        model: 'gemini-3-pro',
        systemInstruction: { parts: [{ text: 'You are terse.' }] },
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
      },
      ctx
    )
    expect(systemContentOf(unified.messages)).toBe('You are terse.')
    // The Gemini-specific key must not leak downstream — the same
    // promise the other surfaces make.
    expect(Reflect.get(unified, 'systemInstruction')).toBeUndefined()
    // The system message goes ahead of contents[]. Reversed, a provider
    // that only honours a leading system would ignore it.
    expect(Reflect.get(Object(unified.messages[0]), 'role')).toBe('system')
  })

  test('a multi-part systemInstruction is joined with newlines', async () => {
    // The other three surfaces carry a plain string. Passing the array
    // through would fork the shape per surface, so gemini alone does not
    // stay an array.
    const unified = await new GeminiTransformer().transformRequestOut(
      {
        model: 'gemini-3-pro',
        systemInstruction: { role: 'system', parts: [{ text: 'You are terse.' }, { text: 'Answer in English.' }] },
        contents: []
      },
      ctx
    )
    expect(systemContentOf(unified.messages)).toBe('You are terse.\nAnswer in English.')
  })

  test('reads snake_case system_instruction and a bare string too', async () => {
    const unified = await new GeminiTransformer().transformRequestOut(
      { model: 'gemini-3-pro', system_instruction: 'You are terse.', contents: [] },
      ctx
    )
    expect(systemContentOf(unified.messages)).toBe('You are terse.')
  })
})
