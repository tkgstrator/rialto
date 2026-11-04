/**
 * Which wire format each model of an api_key provider is served over.
 *
 * `POST /api/providers` carries `modelApiStyles` — the per-model override
 * stored in `Model.apiStyle` — and the apply layer reads the field's
 * presence as the whole meaning of the payload: present, it is the
 * operator's complete view of the overrides; absent, it says nothing, and
 * the stored values must survive a save that never looked at them (the
 * connect flow, a config import, a key rotation).
 *
 * The last cases follow a save through to the runtime registry, because an
 * override that reached the DB but not the chain would change nothing.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import { ApiStyle, ModelTestStatus } from '../../src/generated/prisma/client'
import dayjs from '../../src/lib/dayjs'
import { getLlmsContext, resetLlmsContext } from '../../src/llms'
import type { Provider } from '../../src/schemas/domain/provider'
import { applyUiConfig, ensurePreferenceProfile, upsertProvider } from '../../src/services/config'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

const openai = (models: string[], extra: Partial<Provider> = {}): Provider => ({
  name: 'openai',
  enabled: true,
  api_base_url: 'https://api.openai.com/v1/chat/completions',
  api_key: 'sk-openai',
  auth_mode: 'api_key',
  models,
  ...extra
})

const storedStyles = async (providerName: string): Promise<Record<string, ApiStyle | null>> => {
  const rows = await getPrismaClient().model.findMany({ where: { provider: { name: providerName } } })
  return Object.fromEntries(rows.map((row) => [row.name, row.apiStyle]))
}

describe.skipIf(!HAS_DB)('modelApiStyles on POST /providers (apply layer)', () => {
  beforeEach(async () => {
    await resetDbTables()
    await ensurePreferenceProfile()
    resetLlmsContext()
  })

  afterAll(async () => {
    await teardownPrisma()
  })

  test('stores the style of each listed model and leaves the rest on the provider default', async () => {
    const { provider, warnings } = await upsertProvider(
      openai(['gpt-6-astra', 'gpt-5-mini'], { modelApiStyles: { 'gpt-6-astra': 'openai_responses' } })
    )
    expect(warnings).toEqual([])
    expect(await storedStyles('openai')).toEqual({ 'gpt-6-astra': ApiStyle.openai_responses, 'gpt-5-mini': null })
    // The same map comes back on the read the UI is built on.
    expect(provider.modelApiStyles).toEqual({ 'gpt-6-astra': 'openai_responses' })
  })

  test('a save without the field leaves every stored override as it was', async () => {
    await upsertProvider(
      openai(['gpt-6-astra', 'gpt-5-mini'], { modelApiStyles: { 'gpt-6-astra': 'openai_responses' } })
    )

    // A key rotation through the single-provider path ...
    await upsertProvider(openai(['gpt-6-astra', 'gpt-5-mini'], { api_key: 'sk-rotated' }))
    expect(await storedStyles('openai')).toEqual({ 'gpt-6-astra': ApiStyle.openai_responses, 'gpt-5-mini': null })

    // ... and a whole-config import through the other.
    await applyUiConfig({ Providers: [openai(['gpt-6-astra', 'gpt-5-mini'], { api_key: 'sk-imported' })] })
    expect(await storedStyles('openai')).toEqual({ 'gpt-6-astra': ApiStyle.openai_responses, 'gpt-5-mini': null })
  })

  test('a save with the field is the whole view: an unlisted model goes back to the provider style', async () => {
    await upsertProvider(
      openai(['gpt-6-astra', 'gpt-5-mini'], { modelApiStyles: { 'gpt-6-astra': 'openai_responses' } })
    )

    await upsertProvider(
      openai(['gpt-6-astra', 'gpt-5-mini'], { modelApiStyles: { 'gpt-5-mini': 'openai_responses' } })
    )
    expect(await storedStyles('openai')).toEqual({ 'gpt-6-astra': null, 'gpt-5-mini': ApiStyle.openai_responses })

    // An empty map is still a map: it lifts them all.
    await upsertProvider(openai(['gpt-6-astra', 'gpt-5-mini'], { modelApiStyles: {} }))
    expect(await storedStyles('openai')).toEqual({ 'gpt-6-astra': null, 'gpt-5-mini': null })
  })

  test('lifts the name-derived default of a codex-family row that already existed', async () => {
    await upsertProvider(openai(['gpt-5-codex', 'gpt-5-mini']))
    expect((await storedStyles('openai'))['gpt-5-codex']).toBe(ApiStyle.openai_responses)

    await upsertProvider(openai(['gpt-5-codex', 'gpt-5-mini'], { modelApiStyles: {} }))
    expect((await storedStyles('openai'))['gpt-5-codex']).toBeNull()
  })

  test('a row created in the same save keeps the name-derived default unless the map names it', async () => {
    // The payload could not have seen a row that did not exist yet, so an
    // empty map must not cancel what creation seeds ...
    await upsertProvider(openai(['gpt-5-codex'], { modelApiStyles: {} }))
    expect(await storedStyles('openai')).toEqual({ 'gpt-5-codex': ApiStyle.openai_responses })

    // ... while naming the model is how the operator overrules it.
    await resetDbTables()
    await upsertProvider(openai(['gpt-5-codex'], { modelApiStyles: { 'gpt-5-codex': 'openai_chat' } }))
    expect(await storedStyles('openai')).toEqual({ 'gpt-5-codex': null })
  })

  test("a style equal to the provider's own is stored as null", async () => {
    await upsertProvider(openai(['gpt-6-astra'], { modelApiStyles: { 'gpt-6-astra': 'openai_responses' } }))
    await upsertProvider(openai(['gpt-6-astra'], { modelApiStyles: { 'gpt-6-astra': 'openai_chat' } }))
    expect(await storedStyles('openai')).toEqual({ 'gpt-6-astra': null })
  })

  test('a name outside the provider models is ignored with a warning, and the rest still applies', async () => {
    const { warnings } = await upsertProvider(
      openai(['gpt-6-astra'], {
        modelApiStyles: { 'gpt-6-astra': 'openai_responses', 'gpt-6-typo': 'openai_responses' }
      })
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('gpt-6-typo')
    expect(await storedStyles('openai')).toEqual({ 'gpt-6-astra': ApiStyle.openai_responses })
  })

  test('changing a model style clears its last test result; leaving it alone keeps it', async () => {
    const prisma = getPrismaClient()
    const checkedAt = dayjs('2026-01-01T00:00:00Z').toDate()
    await upsertProvider(openai(['gpt-6-astra', 'gpt-5-mini']))
    await prisma.model.updateMany({
      where: { provider: { name: 'openai' } },
      data: { testStatus: ModelTestStatus.ok, testCheckedAt: checkedAt, testPassedAt: checkedAt }
    })

    await upsertProvider(
      openai(['gpt-6-astra', 'gpt-5-mini'], { modelApiStyles: { 'gpt-6-astra': 'openai_responses' } })
    )
    const rows = await prisma.model.findMany({ where: { provider: { name: 'openai' } } })
    const status = Object.fromEntries(rows.map((row) => [row.name, row.testStatus]))
    // Only the model that moved to the other endpoint lost its result.
    expect(status).toEqual({ 'gpt-6-astra': ModelTestStatus.unknown, 'gpt-5-mini': ModelTestStatus.ok })

    // Saving the same map again changes nothing, so nothing is cleared.
    await prisma.model.updateMany({
      where: { provider: { name: 'openai' }, name: 'gpt-6-astra' },
      data: { testStatus: ModelTestStatus.ok }
    })
    await upsertProvider(
      openai(['gpt-6-astra', 'gpt-5-mini'], { modelApiStyles: { 'gpt-6-astra': 'openai_responses' } })
    )
    const again = await prisma.model.findFirstOrThrow({ where: { name: 'gpt-6-astra' } })
    expect(again.testStatus).toBe(ModelTestStatus.ok)
  })

  test('a subscription provider ignores the field, however it is spelled', async () => {
    const codex = (extra: Partial<Provider>): Provider => ({
      name: 'codex',
      enabled: true,
      api_base_url: 'https://chatgpt.com/backend-api/codex',
      api_key: null,
      auth_mode: 'subscription',
      models: ['gpt-5-codex'],
      ...extra
    })
    await upsertProvider(codex({}))
    expect(await storedStyles('codex')).toEqual({ 'gpt-5-codex': ApiStyle.openai_responses })

    // What a round trip of the read sends back, an empty map, and an
    // explicit attempt to move the model: none of it disturbs the row.
    await upsertProvider(codex({ modelApiStyles: { 'gpt-5-codex': 'openai_responses' } }))
    await upsertProvider(codex({ modelApiStyles: {} }))
    await upsertProvider(codex({ modelApiStyles: { 'gpt-5-codex': 'openai_chat' } }))
    expect(await storedStyles('codex')).toEqual({ 'gpt-5-codex': ApiStyle.openai_responses })
  })

  test('another provider is not touched by a save of this one', async () => {
    await upsertProvider(openai(['gpt-6-astra'], { name: 'proxy', api_base_url: 'https://proxy.example/v1/responses' }))
    await upsertProvider(openai(['gpt-6-astra'], { modelApiStyles: { 'gpt-6-astra': 'openai_responses' } }))
    expect(await storedStyles('proxy')).toEqual({ 'gpt-6-astra': null })
    expect(await storedStyles('openai')).toEqual({ 'gpt-6-astra': ApiStyle.openai_responses })
  })
})

describe.skipIf(!HAS_DB)('modelApiStyles reaches the runtime registry on save', () => {
  beforeEach(async () => {
    await resetDbTables()
    await ensurePreferenceProfile()
    resetLlmsContext()
  })

  afterAll(async () => {
    await teardownPrisma()
  })

  const perModelChain = async (model: string): Promise<string[] | null> => {
    const ctx = await getLlmsContext()
    const block: unknown = ctx.providers.get('openai')?.transformer?.[model]
    if (block === null || typeof block !== 'object' || !('use' in block) || !Array.isArray(block.use)) return null
    return block.use.map((step: unknown) => String(Object(step).name))
  }

  test('a save builds the model chain and a later save removes it, with no restart in between', async () => {
    // Built once, so the second save has a stale context to invalidate.
    await upsertProvider(openai(['gpt-6-astra', 'gpt-5-mini']))
    expect(await perModelChain('gpt-6-astra')).toBeNull()

    await upsertProvider(
      openai(['gpt-6-astra', 'gpt-5-mini'], { modelApiStyles: { 'gpt-6-astra': 'openai_responses' } })
    )
    expect(await perModelChain('gpt-6-astra')).toEqual(['openai-responses'])
    expect(await perModelChain('gpt-5-mini')).toBeNull()
    // The provider's own chain is still the Chat one.
    const ctx = await getLlmsContext()
    expect(ctx.providers.get('openai')?.transformer?.use?.map((t) => t.name)).toEqual(['openai'])

    await upsertProvider(openai(['gpt-6-astra', 'gpt-5-mini'], { modelApiStyles: {} }))
    expect(await perModelChain('gpt-6-astra')).toBeNull()
  })

  test('a Base URL naming /responses is stored as given and still builds the same chains', async () => {
    const { provider } = await upsertProvider(
      openai(['gpt-6-astra', 'gpt-5-mini'], {
        api_base_url: 'https://api.openai.com/v1/responses',
        modelApiStyles: { 'gpt-6-astra': 'openai_responses' }
      })
    )
    expect(provider.api_base_url).toBe('https://api.openai.com/v1/responses')
    expect(await perModelChain('gpt-6-astra')).toEqual(['openai-responses'])
    const ctx = await getLlmsContext()
    expect(ctx.providers.get('openai')?.api_base_url).toBe('https://api.openai.com/v1/responses')
  })
})
