/**
 * Which model a provider's tier routes to.
 *
 * The rule the server routes by and the provider page previews: a tier
 * some model names follows the newest switched-on one; a tier nothing
 * names keeps the operator's alias.
 */
import { describe, expect, test } from 'bun:test'
import { namedModelsOf, newerOffOf, resolveTier } from '../../src/shared/tier-resolution'

const model = (name: string, enabled: boolean) => ({ name, enabled })

describe('resolveTier', () => {
  test('a named tier routes to the newest switched-on model', () => {
    const models = [
      model('claude-sonnet-4-6', true),
      model('claude-sonnet-5', true),
      model('claude-sonnet-5-5', false),
      model('claude-opus-4-8', true)
    ]
    const r = resolveTier(models, 'sonnet', null)
    expect(r.mode).toBe('derived')
    expect(r.model?.name).toBe('claude-sonnet-5')
    expect(newerOffOf(r).map((m) => m.name)).toEqual(['claude-sonnet-5-5'])
  })

  test('switching the newer one on moves the route', () => {
    const models = [model('claude-sonnet-5', true), model('claude-sonnet-5-5', true)]
    const r = resolveTier(models, 'sonnet', null)
    expect(r.model?.name).toBe('claude-sonnet-5-5')
    expect(newerOffOf(r)).toEqual([])
  })

  test('with none switched on, the newest named model resolves switched off', () => {
    const r = resolveTier([model('claude-haiku-4-5', false), model('claude-haiku-3', false)], 'haiku', null)
    expect(r.mode).toBe('derived')
    expect(r.model).toEqual(model('claude-haiku-4-5', false))
    expect(newerOffOf(r)).toEqual([])
  })

  test('a stored alias does not override a named tier', () => {
    const alias = model('claude-mythos-5', true)
    const r = resolveTier([alias, model('claude-fable-5', true)], 'fable', alias)
    expect(r.mode).toBe('derived')
    expect(r.model?.name).toBe('claude-fable-5')
  })

  test('a tier no model names keeps the alias, or nothing', () => {
    const gpt = model('gpt-5.5', true)
    expect(resolveTier([gpt], 'sonnet', gpt)).toEqual({ mode: 'manual', model: gpt })
    expect(resolveTier([gpt], 'sonnet', null)).toEqual({ mode: 'manual', model: null })
  })
})

describe('namedModelsOf', () => {
  test('image models and unnamed families serve no tier', () => {
    const models = [
      model('gpt-image-2.5-flare', true),
      model('claude-mythos-5', true),
      model('claude-opus-4-7', false),
      model('claude-opus-5-5', false)
    ]
    expect(namedModelsOf(models, 'opus').map((m) => m.name)).toEqual(['claude-opus-5-5', 'claude-opus-4-7'])
    expect(namedModelsOf(models, 'fable')).toEqual([])
  })
})
