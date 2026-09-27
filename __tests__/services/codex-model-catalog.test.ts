import { describe, expect, test } from 'bun:test'
import { codexEffortsFor, fetchCodexModels } from '../../src/services/codex-model-catalog'

describe('Codex account model catalog', () => {
  test('reads account-scoped model slugs without leaking authentication to the result', async () => {
    const requested: { url: string; headers: Headers | null } = { url: '', headers: null }
    const fetchModels: typeof fetch = async (url, init) => {
      requested.url = String(url)
      requested.headers = new Headers(init?.headers)
      return Response.json({
        models: [
          { slug: 'account-model-a', visibility: 'list' },
          { slug: 'account-model-b', visibility: 'list' },
          { slug: 'account-model-a', visibility: 'list' },
          { slug: 'hidden-model', visibility: 'hide' }
        ]
      })
    }
    const models = await fetchCodexModels('test-token', 'test-account', fetchModels)
    expect(models).toHaveLength(2)
    expect(models).toContain('account-model-a')
    expect(models).toContain('account-model-b')
    expect(models).not.toContain('hidden-model')
    expect(requested.url).toStartWith('https://chatgpt.com/backend-api/codex/models?client_version=')
    expect(requested.headers?.get('authorization')).toBe('Bearer test-token')
    expect(requested.headers?.get('chatgpt-account-id')).toBe('test-account')
  })

  test('retains only supported levels for each account and visible model', async () => {
    const catalog: typeof fetch = async () =>
      Response.json({
        models: [
          { slug: 'gpt-5.5', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'ultra' }] },
          { slug: 'hidden', visibility: 'hide', supported_reasoning_levels: [{ effort: 'max' }] }
        ]
      })
    await fetchCodexModels('secret', 'acct-1', catalog, 'sub-1')
    expect(codexEffortsFor('sub-1', 'gpt-5.5')).toEqual(['low', 'high'])
    expect(codexEffortsFor('sub-1', 'hidden')).toBeNull()
    expect(codexEffortsFor('sub-2', 'gpt-5.5')).toBeNull()
    const otherAccount: typeof fetch = async () =>
      Response.json({ models: [{ slug: 'gpt-5.5', supported_reasoning_levels: [{ effort: 'medium' }] }] })
    await fetchCodexModels('other-token', 'acct-2', otherAccount, 'sub-2')
    expect(codexEffortsFor('sub-1', 'gpt-5.5')).toEqual(['low', 'high'])
    expect(codexEffortsFor('sub-2', 'gpt-5.5')).toEqual(['medium'])
  })

  test('does not substitute pricing ids when upstream fails or returns a different shape', async () => {
    const unavailable: typeof fetch = async () => new Response('', { status: 503 })
    expect(await fetchCodexModels('test-token', null, unavailable)).toBeNull()
    const malformed: typeof fetch = async () => Response.json({ data: [{ id: 'account-model' }] })
    expect(await fetchCodexModels('test-token', null, malformed)).toBeNull()
  })
})
