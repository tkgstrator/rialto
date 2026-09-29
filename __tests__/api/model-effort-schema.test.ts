import { describe, expect, test } from 'bun:test'
import { UpdateModelBodySchema } from '../../src/schemas/api/models'

describe('model effort PATCH contract', () => {
  test('accepts Auto, existing manual levels, clear and omitted effort', () => {
    expect(UpdateModelBodySchema.safeParse({ reasoningEffort: 'auto' }).success).toBe(true)
    expect(UpdateModelBodySchema.safeParse({ reasoningEffort: 'xhigh' }).success).toBe(true)
    expect(UpdateModelBodySchema.safeParse({ reasoningEffort: null }).success).toBe(true)
    expect(UpdateModelBodySchema.safeParse({ enabled: true }).success).toBe(true)
  })

  test('never accepts Auto as an arbitrary upstream effort level', () => {
    expect(UpdateModelBodySchema.safeParse({ reasoningEffort: 'turbo' }).success).toBe(false)
  })
})
