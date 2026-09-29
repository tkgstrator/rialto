import { describe, expect, test } from 'bun:test'
import { fetchCodexModelCatalog, fetchCodexModels } from '../../src/services/codex-model-catalog'

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

  test('reports each visible model window and the levels this build can name', async () => {
    const catalog: typeof fetch = async () =>
      Response.json({
        models: [
          {
            slug: 'gpt-6-sol',
            context_window: 272000,
            max_context_window: 872000,
            supported_reasoning_levels: [
              { effort: 'low' },
              { effort: 'max' },
              { effort: 'ultra' },
              { effort: 'beyond' }
            ]
          },
          { slug: 'gpt-5.5', context_window: 272000, supported_reasoning_levels: [{ effort: 'medium' }] },
          { slug: 'no-window' },
          { slug: 'hidden', visibility: 'hide', max_context_window: 1, supported_reasoning_levels: [{ effort: 'max' }] }
        ]
      })
    const got = await fetchCodexModelCatalog('secret', 'acct-1', catalog)
    expect(got?.models).toEqual([
      // The raised limit, not the CLI's starting default; an unknown level is dropped.
      { id: 'gpt-6-sol', contextWindow: 872000, efforts: ['low', 'max', 'ultra'] },
      { id: 'gpt-5.5', contextWindow: 272000, efforts: ['medium'] },
      { id: 'no-window', contextWindow: null, efforts: [] }
    ])
  })

  test('does not substitute pricing ids when upstream fails or returns a different shape', async () => {
    const unavailable: typeof fetch = async () => new Response('', { status: 503 })
    expect(await fetchCodexModels('test-token', null, unavailable)).toBeNull()
    const malformed: typeof fetch = async () => Response.json({ data: [{ id: 'account-model' }] })
    expect(await fetchCodexModels('test-token', null, malformed)).toBeNull()
  })
})
