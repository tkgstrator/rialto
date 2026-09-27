import { describe, expect, test } from 'bun:test'
import { fetchClaudeCodeModels } from '../../src/services/claude-code-model-catalog'

const catalog = {
  schema_version: 1,
  surfaces: {
    cc: {
      model_selector_config: [
        {
          id: 'cc',
          models: [
            { id: 'claude-opus-5-5', offered_on: ['first_party', 'gateway'], section: 'main' },
            { id: 'claude-opus-5-5', offered_on: ['first_party'], section: 'main' },
            { id: 'claude-sonnet-5', offered_on: ['gateway'], section: 'main' },
            { id: 'claude-old-4', offered_on: ['first_party'], section: 'overflow' }
          ]
        }
      ]
    },
    chat: { model_selector_config: [{ id: 'chat', models: [{ id: 'claude-chat-only', offered_on: ['first_party'] }] }] }
  }
}

describe('Claude Code published model catalog', () => {
  test('discovers first-party models in the Claude Code selector', async () => {
    const requested: { url: string; authorization: string | null } = { url: '', authorization: null }
    const fetchModels: typeof fetch = async (url, init) => {
      requested.url = String(url)
      requested.authorization = new Headers(init?.headers).get('authorization')
      return Response.json(catalog)
    }
    expect(await fetchClaudeCodeModels(fetchModels)).toEqual(['claude-opus-5-5', 'claude-old-4'])
    expect(requested.url).toBe('https://downloads.claude.ai/model-catalog/v1/catalog.json')
    expect(requested.authorization).toBeNull()
  })

  test('retains existing candidates when the endpoint fails or changes shape', async () => {
    const unavailable: typeof fetch = async () => new Response('', { status: 503 })
    expect(await fetchClaudeCodeModels(unavailable)).toBeNull()
    const malformed: typeof fetch = async () => Response.json({ ...catalog, schema_version: 2 })
    expect(await fetchClaudeCodeModels(malformed)).toBeNull()
  })
})
