/**
 * A `tool_result` carrying an image is weighed as its text, not as the
 * length of its base64 payload.
 *
 * Both backends used to JSON.stringify a tool_result's non-string
 * content, so a screenshot returned by a tool — a nested
 * `{type:'image', source:{data:<base64>}}` block — counted as a million
 * tokens of prose while the same block at the top level of a message
 * counted 0. Every request after it classified as longContext.
 */

import { describe, expect, test } from 'bun:test'
import { HuggingFaceTokenizer } from '../../../src/llms/tokenizers/huggingface'
import { TiktokenTokenizer } from '../../../src/llms/tokenizers/tiktoken'

const BASE64 = 'A'.repeat(200_000)

const image = () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: BASE64 } })
const text = (t: string) => ({ type: 'text', text: t })

const toolResultRequest = (content: unknown) => ({
  messages: [{ role: 'user', content: [{ type: 'tool_result', content }] }],
  tools: []
})

describe('tiktoken', () => {
  const tokenizer = new TiktokenTokenizer('cl100k_base')

  test('an image inside a tool_result weighs nothing', async () => {
    const withImage = await tokenizer.countTokens(toolResultRequest([text('Screenshot taken.'), image()]))
    const textOnly = await tokenizer.countTokens(toolResultRequest([text('Screenshot taken.')]))
    expect(withImage).toBe(textOnly)
    expect(withImage).toBeLessThan(50)
  })

  test('a string tool_result still counts as text', async () => {
    const n = await tokenizer.countTokens(toolResultRequest('lorem ipsum dolor sit amet'))
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(20)
  })

  test('a non-block object is still serialised, since it is text-shaped', async () => {
    const n = await tokenizer.countTokens(toolResultRequest({ ok: true, rows: 3 }))
    expect(n).toBeGreaterThan(0)
  })

  test('a nested tool_use inside a tool_result is counted as one', async () => {
    const nested = await tokenizer.countTokens(
      toolResultRequest([{ type: 'tool_use', input: { path: '/tmp/a' } }, image()])
    )
    const direct = await tokenizer.countTokens({
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', input: { path: '/tmp/a' } }] }],
      tools: []
    })
    expect(nested).toBe(direct)
  })
})

describe('huggingface (flattening only)', () => {
  // The HF backend needs a downloaded vocabulary to count; the part
  // under test is the request → text flattening, which is reachable
  // without one.
  const flatten = (content: unknown): string => {
    const tokenizer = new HuggingFaceTokenizer({ model: 'never/downloaded' })
    // biome-ignore lint/complexity/useLiteralKeys: reaching a private method on purpose
    return tokenizer['extractTextFromRequest'](toolResultRequest(content))
  }

  test('an image inside a tool_result contributes no text', () => {
    expect(flatten([text('Screenshot taken.'), image()])).toBe('Screenshot taken.')
  })

  test('a string tool_result passes through', () => {
    expect(flatten('done')).toBe('done')
  })
})
