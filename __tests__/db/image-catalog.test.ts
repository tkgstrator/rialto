import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { providerFromCatalog } from '../../src/components/rialto/providers/connect-actions'
import { getPrismaClient } from '../../src/db/client'
import { AuthMode } from '../../src/generated/prisma/client'
import { CatalogEntrySchema } from '../../src/schemas/api/catalog'
import { getCatalog } from '../../src/services/catalog-service'
import { apiStyleForVendor } from '../../src/services/config'
import { syncConnectedCodexModels } from '../../src/services/model-sync-service'
import { CODEX_IMAGE_MODELS } from '../../src/shared/data/subscriptions'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

// The Claude Code catalog is read lazily by getCatalog; these tests are
// about Codex, so that read is answered offline.
const offline: typeof fetch = async () => new Response(null, { status: 503 })

describe.skipIf(!HAS_DB)('Codex image catalog', () => {
  afterAll(teardownPrisma)
  beforeEach(resetDbTables)

  test('before an account connects, Codex offers only its image models, all landing off', async () => {
    const codex = (await getCatalog(offline)).find((entry) => entry.name === 'codex')
    expect(codex).toBeDefined()
    if (codex === undefined) return
    // Chat models come from the connected account's own list, never from
    // a list shipped with Rialto.
    expect(codex.models.map((model) => model.name)).toEqual([...CODEX_IMAGE_MODELS].sort())
    const connected = providerFromCatalog(codex)
    expect(connected.models).toEqual([...CODEX_IMAGE_MODELS].sort())
    expect(connected.transformer?._disabledModels).toEqual([...CODEX_IMAGE_MODELS].sort())
  })

  test('connection discovery persists account models without replacing existing choices', async () => {
    await resetDbTables()
    const prisma = getPrismaClient()
    const provider = await prisma.provider.create({
      data: {
        name: 'codex',
        apiBaseUrl: 'https://chatgpt.com/backend-api/codex',
        authMode: AuthMode.subscription,
        apiStyle: apiStyleForVendor('codex'),
        models: { create: [{ name: 'existing-model', enabled: true }] }
      }
    })
    const fetchModels: typeof fetch = async () =>
      Response.json({ models: [{ slug: 'discovered-model' }, { slug: 'existing-model' }] })
    await syncConnectedCodexModels(['codex'], 'test-token', 'test-account', fetchModels)
    const rows = await prisma.model.findMany({ where: { providerId: provider.id }, orderBy: { name: 'asc' } })
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.name === 'discovered-model')?.enabled).toBe(false)
    expect(rows.find((row) => row.name === 'existing-model')?.enabled).toBe(true)
    const codex = (await getCatalog(offline)).find((entry) => entry.name === 'codex')
    expect(codex?.models.some((model) => model.name === 'discovered-model')).toBe(true)
    expect(codex?.models.find((model) => model.name === 'discovered-model')?.inputPer1M).toBeNull()
  })

  test('includes only curated image ids, with modality pricing instead of an undifferentiated rate', async () => {
    const entries = await getCatalog(offline)
    const codex = entries.find((entry) => entry.name === 'codex')
    expect(codex).toBeDefined()
    expect(CatalogEntrySchema.safeParse(codex).success).toBe(true)
    for (const name of CODEX_IMAGE_MODELS) {
      const row = codex?.models.find((model) => model.name === name)
      expect(row?.imagePricing?.source).toBe(`https://developers.openai.com/api/docs/models/${name}`)
      expect(row?.imagePricing?.textInputPer1M).toBe(5)
      expect(row?.imagePricing?.imageInputPer1M).toBe(8)
      expect(row?.imagePricing?.imageOutputPer1M).toBe(30)
      expect(row?.inputPer1M).toBeNull()
      expect(row?.outputPer1M).toBeNull()
    }
    const openai = entries.find((entry) => entry.name === 'openai')
    expect(openai?.models.some((model) => CODEX_IMAGE_MODELS.includes(model.name))).toBe(false)
  })
})
