import { describe, expect, test } from 'bun:test'
import type { TokenPlan } from '../../src/services/access-token-auth'
import { decidePlanModel } from '../../src/services/plan-model'

const plan: TokenPlan = {
  models: ['a,one', 'b,two'],
  defaultModel: 'a,one',
  limits: { '5h': { requests: 5, spendUsd: null }, '7d': { requests: null, spendUsd: null } }
}

describe('decidePlanModel', () => {
  test('leaves a token with no plan to the caller', () => {
    expect(decidePlanModel(null, 'x,y')).toEqual({ kind: 'unrestricted' })
    expect(decidePlanModel(undefined, undefined)).toEqual({ kind: 'unrestricted' })
  })

  test('keeps a listed qualified model', () => {
    expect(decidePlanModel(plan, 'b,two')).toEqual({ kind: 'allowed', model: 'b,two' })
  })

  test('resolves a bare name that exactly one listed model carries', () => {
    expect(decidePlanModel(plan, 'two')).toEqual({ kind: 'allowed', model: 'b,two' })
  })

  test('keeps a bare name several listed providers host, for provider priority to settle', () => {
    const shared: TokenPlan = { ...plan, models: ['a,one', 'b,one', 'c,three'], defaultModel: 'c,three' }
    expect(decidePlanModel(shared, 'one')).toEqual({ kind: 'allowed', model: 'one' })
  })

  test('uses the plan default only when the request names no model', () => {
    expect(decidePlanModel(plan, undefined)).toEqual({ kind: 'default', model: 'a,one' })
    expect(decidePlanModel(plan, '')).toEqual({ kind: 'default', model: 'a,one' })
  })

  test('denies a model the plan does not list, naming it and the allowed ones', () => {
    expect(decidePlanModel(plan, 'c,three')).toEqual({
      kind: 'denied',
      message: 'Model "c,three" is not allowed for this token. Allowed models: a,one, b,two.'
    })
  })

  test('denies a listed name under the wrong provider rather than rewriting it', () => {
    expect(decidePlanModel(plan, 'b,one').kind).toBe('denied')
  })

  test('denies a bare name no listed model carries', () => {
    expect(decidePlanModel(plan, 'three').kind).toBe('denied')
  })
})
