import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { providerFromCatalog } from '../../src/components/rialto/providers/connect-actions'
import { getPrismaClient } from '../../src/db/client'
import { AuthMode } from '../../src/generated/prisma/client'
import { getCatalog } from '../../src/services/catalog-service'
import {
  __resetClaudeCodeModelsForTests,
  claudeCodeModels,
  refreshClaudeCodeModels
} from '../../src/services/claude-code-model-catalog'
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
  beforeEach(async () => {
    await resetDbTables()
    __resetClaudeCodeModelsForTests()
  })

  test('shows discovered models as disabled choices for a new provider', async () => {
    expect(await refreshClaudeCodeModels(fetchModels)).toBe(true)
    const entry = (await getCatalog(fetchModels)).find((provider) => provider.name === 'claude-code')
    expect(entry?.models.map((model) => model.name)).toEqual(['claude-opus-5-5'])
    if (entry === undefined) return
    const provider = providerFromCatalog(entry)
    expect(provider.models).toEqual(['claude-opus-5-5'])
    expect(provider.transformer?._disabledModels).toEqual(['claude-opus-5-5'])
  })

  test('a fresh process reads the published catalog on the first catalog view', async () => {
    expect(claudeCodeModels()).toEqual([])
    const entry = (await getCatalog(fetchModels)).find((provider) => provider.name === 'claude-code')
    expect(entry?.models.map((model) => model.name)).toEqual(['claude-opus-5-5'])
  })

  test('a failed read is not retried on every catalog view', async () => {
    const calls: string[] = []
    const unavailable: typeof fetch = async (input) => {
      calls.push(String(input))
      return new Response(null, { status: 503 })
    }
    const first = (await getCatalog(unavailable)).find((provider) => provider.name === 'claude-code')
    expect(first?.models).toEqual([])
    await getCatalog(unavailable)
    expect(calls).toHaveLength(1)
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
    const entry = (await getCatalog(fetchModels)).find((provider) => provider.name === 'claude-code')
    expect(entry?.models.some((model) => model.name === 'claude-opus-5-5')).toBe(true)
    const existing = await prisma.model.findFirst({ where: { name: 'claude-opus-4-8' } })
    expect(existing?.enabled).toBe(true)
  })
})
