import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { providerFromCatalog } from '../../src/components/rialto/providers/connect-actions'
import { getPrismaClient } from '../../src/db/client'
import { AuthMode } from '../../src/generated/prisma/client'
import { getCatalog } from '../../src/services/catalog-service'
import { refreshClaudeCodeModels } from '../../src/services/claude-code-model-catalog'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

const fetchModels: typeof fetch = async () =>
  Response.json({
    schema_version: 1,
    surfaces: {
      cc: {
        model_selector_config: [
          {
            id: 'cc',
            models: [{ id: 'claude-opus-5-5', offered_on: ['first_party'], runtime: { max_input_tokens: 1_000_000 } }]
          }
        ]
      }
    }
  })

describe.skipIf(!HAS_DB)('Claude Code model catalog', () => {
  afterAll(teardownPrisma)
  beforeEach(resetDbTables)

  test('shows discovered models as disabled choices for a new provider', async () => {
    expect(await refreshClaudeCodeModels(fetchModels)).toBe(true)
    const entry = (await getCatalog()).find((provider) => provider.name === 'claude-code')
    expect(entry?.models.some((model) => model.name === 'claude-opus-5-5')).toBe(true)
    expect(entry?.defaultEnabledModels).not.toContain('claude-opus-5-5')
    if (entry === undefined) return
    const provider = providerFromCatalog(entry)
    expect(provider.models).toContain('claude-opus-5-5')
    expect(provider.transformer?._disabledModels).toContain('claude-opus-5-5')
  })

  test('keeps existing provider choices and lists discovered models', async () => {
    const prisma = getPrismaClient()
    await prisma.provider.create({
      data: {
        name: 'claude-code',
        apiBaseUrl: 'https://api.anthropic.com/v1/messages',
        authMode: AuthMode.subscription,
        models: { create: [{ name: 'claude-opus-4-8', enabled: true }] }
      }
    })
    expect(await refreshClaudeCodeModels(fetchModels)).toBe(true)
    const entry = (await getCatalog()).find((provider) => provider.name === 'claude-code')
    expect(entry?.models.some((model) => model.name === 'claude-opus-5-5')).toBe(true)
    const existing = await prisma.model.findFirst({ where: { name: 'claude-opus-4-8' } })
    expect(existing?.enabled).toBe(true)
  })
})
