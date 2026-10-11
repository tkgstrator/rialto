/**
 * Chat-Completions `response_format` → Responses-API `text.format`
 * translation. The two surfaces share the same three format types but
 * differ in how json_schema is nested:
 *
 *   Chat:      {type:'json_schema', json_schema:{name,schema,strict?}}
 *   Responses: {type:'json_schema', name, schema, strict?}
 *
 * codex allow-lists top-level params and rejects raw `response_format`
 * with 400, so the reporter's strict-json production pipeline needs
 * this translation to work on /v1/chat/completions → codex.
 */

import { describe, expect, test } from 'bun:test'
import { AnthropicTransformer } from '../../src/llms/transformers/anthropic'
import { OpenAIResponsesTransformer } from '../../src/llms/transformers/openai'
import { shapeCodexBody } from '../../src/llms/transformers/openai/codex/request-shape'
import { convertResponseFormatToTextFormat } from '../../src/llms/transformers/openai/responses/request'
import { UnifiedChatRequestSchema } from '../../src/schemas/domain/unified'
import { AnthropicIncomingRequestSchema } from '../../src/schemas/wire/anthropic/messages'

// The installed Anthropic SDK's JSONOutputFormat and BetaJSONOutputFormat
// both carry {type, schema}; neither supplies an OpenAI format name.
const outputSchema = {
  type: 'object',
  properties: {
    permission: { type: 'string', enum: ['allow', 'deny'] },
    rationale: { type: 'string' }
  },
  required: ['permission', 'rationale'],
  additionalProperties: false,
  $defs: { note: { type: 'string' } }
}
const format = { type: 'json_schema', schema: outputSchema }
const inbound = {
  model: 'gpt-5.5',
  max_tokens: 1024,
  stream: false,
  messages: [{ role: 'user', content: 'Return a permission assessment in JSON.' }]
}

describe('Anthropic structured output to Codex', () => {
  for (const fields of [{ output_config: { format, effort: 'low' } }, { output_format: format }]) {
    test(`preserves ${Object.keys(fields)[0]} through unified and Codex text.format`, async () => {
      const original = { ...inbound, ...fields }
      const unified = await new AnthropicTransformer().transformRequestOut(original, {})
      expect(unified.stream).toBe(false)
      expect(unified.response_format).toEqual({
        type: 'json_schema',
        json_schema: { name: 'anthropic_output', schema: outputSchema, strict: true }
      })
      const parsed = UnifiedChatRequestSchema.safeParse(unified)
      expect(parsed.success).toBe(true)
      if (!parsed.success) throw parsed.error
      expect(parsed.data.response_format).toEqual(unified.response_format)
      const result = await new OpenAIResponsesTransformer().transformRequestIn(parsed.data)
      const responses = Object(result)
      const body = 'body' in responses ? Object(responses.body) : responses
      const codex = shapeCodexBody(
        body,
        { writesInstructions: false, parallelToolCalls: true, reasoningSummary: undefined },
        null
      )
      expect(codex.text).toEqual({
        verbosity: 'low',
        format: { type: 'json_schema', name: 'anthropic_output', schema: outputSchema, strict: true }
      })
      for (const field of ['response_format', 'output_config', 'output_format']) {
        expect(codex).not.toHaveProperty(field)
      }
      expect(original).toEqual({ ...inbound, ...fields })
    })
  }

  test('direct conversion also refuses safeguards before schema parsing can discard it', async () => {
    await expect(
      new AnthropicTransformer().transformRequestOut({ ...inbound, output_config: { format }, safeguards: {} }, {})
    ).rejects.toThrow('Anthropic safeguards cannot be converted')
  })

  test('modern format wins over legacy, including explicit null', async () => {
    const endpoint = new AnthropicTransformer()
    const modern = await endpoint.transformRequestOut(
      { ...inbound, output_config: { format }, output_format: { type: 'json_schema', schema: { type: 'string' } } },
      {}
    )
    expect(modern.response_format?.type).toBe('json_schema')
    expect(modern.response_format).toHaveProperty('json_schema.schema', outputSchema)
    const disabled = await endpoint.transformRequestOut(
      { ...inbound, output_config: { format: null }, output_format: format },
      {}
    )
    expect(disabled.response_format).toBeUndefined()
  })

  test('effort-only config, absent format and nullable legacy do not imply structured output', async () => {
    for (const fields of [{}, { output_config: { effort: 'high' } }, { output_format: null }]) {
      const unified = await new AnthropicTransformer().transformRequestOut({ ...inbound, ...fields }, {})
      expect(unified.response_format).toBeUndefined()
      expect(unified.stream).toBe(false)
    }
  })

  test('rejects malformed or guessed Anthropic format shapes rather than generating unrestricted text', () => {
    for (const malformed of [
      { type: 'json_schema' },
      { type: 'json_schema', schema: 'not a schema' },
      { type: 'json_schema', schema: [] },
      { type: 'json_object' },
      { type: 'json_schema', json_schema: { name: 'wrong', schema: outputSchema } }
    ]) {
      expect(
        AnthropicIncomingRequestSchema.safeParse({ ...inbound, output_config: { format: malformed } }).success
      ).toBe(false)
      expect(AnthropicIncomingRequestSchema.safeParse({ ...inbound, output_format: malformed }).success).toBe(false)
    }
  })
})

describe('convertResponseFormatToTextFormat', () => {
  test('text passes through as {type:text}', () => {
    expect(convertResponseFormatToTextFormat({ type: 'text' })).toEqual({ type: 'text' })
  })

  test('json_object passes through as {type:json_object}', () => {
    expect(convertResponseFormatToTextFormat({ type: 'json_object' })).toEqual({ type: 'json_object' })
  })

  test('json_schema flattens the nested json_schema wrapper onto the format', () => {
    const converted = convertResponseFormatToTextFormat({
      type: 'json_schema',
      json_schema: {
        name: 'Comments',
        strict: true,
        description: 'per-index comment array',
        schema: {
          type: 'object',
          properties: {
            comments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer' },
                  text: { type: 'string' }
                },
                required: ['index', 'text']
              }
            }
          },
          required: ['comments']
        }
      }
    })
    expect(converted).toEqual({
      type: 'json_schema',
      name: 'Comments',
      strict: true,
      description: 'per-index comment array',
      schema: {
        type: 'object',
        properties: {
          comments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                text: { type: 'string' }
              },
              required: ['index', 'text']
            }
          }
        },
        required: ['comments']
      }
    })
  })

  test('unknown response_format type returns null (caller drops the field)', () => {
    expect(convertResponseFormatToTextFormat({ type: 'yaml_output' })).toBeNull()
  })

  test('json_schema without a json_schema block returns null', () => {
    expect(convertResponseFormatToTextFormat({ type: 'json_schema' })).toBeNull()
  })

  test('non-object input returns null', () => {
    expect(convertResponseFormatToTextFormat(null)).toBeNull()
    expect(convertResponseFormatToTextFormat('string')).toBeNull()
    expect(convertResponseFormatToTextFormat(42)).toBeNull()
  })
})
