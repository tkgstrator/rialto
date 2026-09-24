/**
 * Routing-signal extraction for the gemini surface.
 *
 * `/v1beta/models/*` is the one surface of the four that puts the body,
 * the system prompt and the tools under different keys than Anthropic.
 * While it had no reader, all of that read as absent: `contents` was
 * never counted, so the context-window gate always saw 0 tokens, and a
 * `googleSearch` tool never reached the web-search gate.
 *
 * These go through `readSignals` rather than calling the reader
 * directly. Covering the surface-id → reader registration is what stops
 * a correct-but-unwired reader from passing.
 */

import { describe, expect, test } from 'bun:test'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { readSignals } from '../../src/llms/scenario-router/surface-signals'
import type { RouterRequestBody } from '../../src/llms/scenario-router/types'

const GEMINI_PATH = '/v1beta/models/gemini-3-pro:generateContent'

const signals = (body: Record<string, unknown>) => {
  const withModel: RouterRequestBody = { model: 'google,gemini-3-pro', ...body }
  return readSignals(withModel, GEMINI_PATH)
}

/** Count with the real tokenizer (cl100k_base) — whether the answer is
 *  zero is the whole question. */
async function countTokens(body: Record<string, unknown>): Promise<number> {
  const tokenizers = new TokenizerRegistry()
  await tokenizers.initialize()
  const result = await tokenizers.countTokens(signals(body).tokenize)
  return result.tokenCount
}

describe('tokenize — counting contents[]', () => {
  test('parts[].text lands in messages', () => {
    const { tokenize } = signals({
      contents: [
        { role: 'user', parts: [{ text: 'hello' }, { text: 'world' }] },
        { role: 'model', parts: [{ text: 'hi' }] }
      ]
    })
    expect(tokenize.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'world' }
        ]
      },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }
    ])
  })

  test('a long conversation is not 0 tokens — the gap itself', async () => {
    const long = 'lorem ipsum dolor sit amet '.repeat(200)
    expect(await countTokens({ contents: [{ role: 'user', parts: [{ text: long }] }] })).toBeGreaterThan(500)
  })

  test('counts contents with no role, which Gemini treats as user', async () => {
    expect(await countTokens({ contents: [{ parts: [{ text: 'no role here' }] }] })).toBeGreaterThan(0)
  })

  test('systemInstruction is included in the count', async () => {
    const instruction = 'you are a terse assistant '.repeat(50)
    const withSystem = await countTokens({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      systemInstruction: { parts: [{ text: instruction }] }
    })
    const withoutSystem = await countTokens({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    expect(withSystem).toBeGreaterThan(withoutSystem)
    expect(signals({ systemInstruction: { parts: [{ text: 'be terse' }] } }).tokenize.system).toBe('be terse')
  })

  test('reads snake_case system_instruction too', () => {
    expect(signals({ system_instruction: { parts: [{ text: 'be terse' }] } }).tokenize.system).toBe('be terse')
  })

  test('functionCall arguments and functionResponse contents are counted', async () => {
    const args = { query: 'x'.repeat(400) }
    const called = await countTokens({
      contents: [{ role: 'model', parts: [{ functionCall: { name: 'search', args } }] }]
    })
    const answered = await countTokens({
      contents: [
        { role: 'user', parts: [{ functionResponse: { name: 'search', response: { result: 'y'.repeat(400) } } }] }
      ]
    })
    expect(called).toBeGreaterThan(50)
    expect(answered).toBeGreaterThan(50)
  })

  test('a tool JSON schema is counted too', async () => {
    const withTools = await countTokens({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'search',
              description: 'search the web',
              parameters: { type: 'object', properties: { q: { type: 'string', description: 'z'.repeat(400) } } }
            }
          ]
        }
      ]
    })
    const withoutTools = await countTokens({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    expect(withTools).toBeGreaterThan(withoutTools + 50)
  })

  test('a body that is not Gemini does not borrow the Anthropic answer', () => {
    // A body carrying `messages` arriving on the gemini surface is not
    // in Gemini's vocabulary. Falling back would quietly restore the
    // state where the surface's own vocabulary goes unread.
    const { tokenize } = signals({ contents: 'not an array' })
    expect(tokenize.messages).toEqual([])
    expect(tokenize.tools).toEqual([])
  })
})

describe('webSearch', () => {
  test('googleSearch sets webSearch', () => {
    expect(signals({ tools: [{ googleSearch: {} }] }).webSearch).toBe(true)
  })

  test('1.5-era googleSearchRetrieval and its snake_case form set it too', () => {
    expect(signals({ tools: [{ googleSearchRetrieval: { dynamicRetrievalConfig: {} } }] }).webSearch).toBe(true)
    expect(signals({ tools: [{ google_search_retrieval: {} }] }).webSearch).toBe(true)
    expect(signals({ tools: [{ google_search: {} }] }).webSearch).toBe(true)
  })

  test('ordinary function tools alone do not set webSearch', () => {
    expect(signals({ tools: [{ functionDeclarations: [{ name: 'search_web' }] }] }).webSearch).toBe(false)
    expect(signals({ tools: [{ codeExecution: {} }] }).webSearch).toBe(false)
  })

  test('false when there are no tools', () => {
    expect(signals({ contents: [] }).webSearch).toBe(false)
  })
})
