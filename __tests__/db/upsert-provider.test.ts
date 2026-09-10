/**
 * upsertProvider — CRUD single-provider path.
 *
 * Regression coverage for the cascade-delete incident: PATCH
 * /api/providers/:name used to route through applyProviders, which
 * starts with deleteRemovedProviders and eats every provider not
 * listed in the incoming payload. Because the CRUD path only ever
 * passes ONE provider, the effect was "editing one provider deletes
 * every other one (and every SubAccount attached via onDelete: Cascade)"
 * — the exact bug that wiped an operator's OAuth credentials on a
 * routine save.
 *
 * These tests pin the fix: upsertProvider must upsert only the target
 * row and leave every other Provider / chain entry / SubAccount intact.
 * The one deletion that does cascade — deleting a provider outright —
 * has to say how many chain entries went with it.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import { applyUiConfig, deleteProviderByName, ensurePreferenceProfile, upsertProvider } from '../../src/services/config'
import { applyRouterPreferences, loadRouterPreferences } from '../../src/services/router-preference-service'
import { profileWith } from '../llms/chain-fixture'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

describe.skipIf(!HAS_DB)('upsertProvider — no cascade to sibling providers', () => {
  beforeEach(async () => {
    await resetDbTables()
    await ensurePreferenceProfile()
  })

  afterAll(async () => {
    await teardownPrisma()
  })

  // Seed three providers via applyUiConfig (which is the ONLY path that
  // should be able to delete-what's-not-listed). Then flip a single
  // provider through the CRUD path and confirm the other two survive.
  test('editing one provider leaves siblings untouched', async () => {
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v1/chat/completions',
          api_key: 'sk-openai',
          auth_mode: 'api_key',
          models: ['gpt-5-nano', 'gpt-5-mini']
        },
        {
          name: 'anthropic',
          api_base_url: 'https://api.anthropic.com/v1/messages',
          api_key: 'sk-ant',
          auth_mode: 'api_key',
          models: ['claude-sonnet-5']
        },
        {
          name: 'deepseek',
          api_base_url: 'https://api.deepseek.com/chat/completions',
          api_key: 'sk-deep',
          auth_mode: 'api_key',
          models: ['deepseek-chat']
        }
      ]
    })

    const prisma = getPrismaClient()
    expect(await prisma.provider.count()).toBe(3)

    // Edit only the openai provider — bump its api_key and add a model.
    await upsertProvider({
      name: 'openai',
      api_base_url: 'https://api.openai.com/v1/chat/completions',
      api_key: 'sk-openai-ROTATED',
      auth_mode: 'api_key',
      models: ['gpt-5-nano', 'gpt-5-mini', 'gpt-5.6-luna']
    })

    const providers = await prisma.provider.findMany({
      orderBy: { name: 'asc' },
      include: { models: { orderBy: { name: 'asc' } } }
    })
    expect(providers.map((p) => p.name)).toEqual(['anthropic', 'deepseek', 'openai'])

    // openai took the update
    const openai = providers.find((p) => p.name === 'openai')
    expect(openai?.apiKey).toBe('sk-openai-ROTATED')
    // Postgres collation orders `.` and `-` differently from JS; sort
    // in JS so the assertion is deterministic across host collations.
    expect(openai?.models.map((m) => m.name).sort()).toEqual(['gpt-5-mini', 'gpt-5-nano', 'gpt-5.6-luna'].sort())

    // siblings intact
    const anthropic = providers.find((p) => p.name === 'anthropic')
    expect(anthropic?.apiKey).toBe('sk-ant')
    expect(anthropic?.models.map((m) => m.name)).toEqual(['claude-sonnet-5'])
    const deepseek = providers.find((p) => p.name === 'deepseek')
    expect(deepseek?.apiKey).toBe('sk-deep')
  })

  test("editing a provider does not cascade-delete a sibling subscription provider's SubAccount rows", async () => {
    const prisma = getPrismaClient()
    // Seed openai + a subscription-shaped claude-code with a SubAccount
    // row. `applyProviders` never creates SubAccount rows itself — the
    // sync service owns them — so we plant one directly.
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v1/chat/completions',
          api_key: 'sk-openai',
          auth_mode: 'api_key',
          models: ['gpt-5-nano']
        },
        {
          name: 'claude-code',
          api_base_url: 'https://api.anthropic.com/v1/messages',
          api_key: null,
          auth_mode: 'subscription',
          models: ['claude-sonnet-5']
        }
      ]
    })
    const claudeCode = await prisma.provider.findUniqueOrThrow({ where: { name: 'claude-code' } })
    await prisma.subAccount.create({
      data: {
        providerId: claudeCode.id,
        sourcePath: 'oauth:claude:test-user',
        label: 'test',
        // Encryption format is iv.tag.body base64; a placeholder value
        // is fine because the test never decrypts — it only asserts the
        // row survives the CRUD-single-provider upsert on the sibling.
        accessTokenEnc: 'iv.tag.body',
        refreshTokenEnc: 'iv.tag.body'
      }
    })
    // Flip openai through the CRUD path — this is the reproducer for
    // the incident that wiped subscription credentials in production.
    await upsertProvider({
      name: 'openai',
      api_base_url: 'https://api.openai.com/v1/chat/completions',
      api_key: 'sk-openai-ROTATED',
      auth_mode: 'api_key',
      models: ['gpt-5-nano']
    })

    // claude-code provider still there, SubAccount still there.
    const after = await prisma.provider.findUnique({
      where: { name: 'claude-code' },
      include: { subscriptionAccounts: true }
    })
    expect(after).not.toBeNull()
    expect(after?.subscriptionAccounts).toHaveLength(1)
    expect(after?.subscriptionAccounts[0].sourcePath).toBe('oauth:claude:test-user')
  })

  const seedTwoProvidersWithChain = async () => {
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v1/chat/completions',
          api_key: 'sk-openai',
          auth_mode: 'api_key',
          models: ['gpt-5-nano']
        },
        {
          name: 'anthropic',
          api_base_url: 'https://api.anthropic.com/v1/messages',
          api_key: 'sk-ant',
          auth_mode: 'api_key',
          models: ['claude-sonnet-5']
        }
      ]
    })
    const outcome = await applyRouterPreferences(
      profileWith({
        'default.agent': ['anthropic,claude-sonnet-5', 'openai,gpt-5-nano'],
        'think.subagent': ['anthropic,claude-sonnet-5']
      })
    )
    expect(outcome.warnings).toEqual([])
  }

  test("editing a provider does not remove chain entries naming another provider's models", async () => {
    await seedTwoProvidersWithChain()

    // Edit openai — the chain's default primary is anthropic and must
    // survive because the CRUD path never touches sibling providers.
    const { warnings } = await upsertProvider({
      name: 'openai',
      api_base_url: 'https://api.openai.com/v1/chat/completions',
      api_key: 'sk-openai-ROTATED',
      auth_mode: 'api_key',
      models: ['gpt-5-nano']
    })
    expect(warnings).toEqual([])

    const after = await loadRouterPreferences()
    expect(after.entriesByScenario.default.agent.map((e) => e.target)).toEqual([
      'anthropic,claude-sonnet-5',
      'openai,gpt-5-nano'
    ])
  })

  test('removing a model through the CRUD path reports the chain entries that cascade away', async () => {
    await seedTwoProvidersWithChain()
    const { warnings } = await upsertProvider({
      name: 'openai',
      api_base_url: 'https://api.openai.com/v1/chat/completions',
      api_key: 'sk-openai',
      auth_mode: 'api_key',
      models: []
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Removed 1 chain entry')
    expect(warnings[0]).toContain('live/default/agent')
    const after = await loadRouterPreferences()
    expect(after.entriesByScenario.default.agent.map((e) => e.target)).toEqual(['anthropic,claude-sonnet-5'])
  })

  test('deleting a provider reports every chain entry that went with it, by profile, scenario and lane', async () => {
    await seedTwoProvidersWithChain()
    const { warnings } = await deleteProviderByName('anthropic')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Removed 2 chain entries')
    expect(warnings[0]).toContain('live/default/agent')
    expect(warnings[0]).toContain('live/think/subagent')

    const after = await loadRouterPreferences()
    expect(after.entriesByScenario.default.agent.map((e) => e.target)).toEqual(['openai,gpt-5-nano'])
    expect(after.entriesByScenario.think.subagent).toEqual([])
  })

  test('deleting a provider no chain names reports nothing', async () => {
    await seedTwoProvidersWithChain()
    await applyRouterPreferences(profileWith({ 'default.agent': ['anthropic,claude-sonnet-5'] }))
    const { warnings } = await deleteProviderByName('openai')
    expect(warnings).toEqual([])
  })

  test('a fresh provider name via upsertProvider still creates the row (create path)', async () => {
    await upsertProvider({
      name: 'brand-new',
      api_base_url: 'https://example.com/v1/chat/completions',
      api_key: 'sk-new',
      auth_mode: 'api_key',
      models: ['x']
    })
    const prisma = getPrismaClient()
    const p = await prisma.provider.findUnique({ where: { name: 'brand-new' }, include: { models: true } })
    expect(p?.apiKey).toBe('sk-new')
    expect(p?.models.map((m) => m.name)).toEqual(['x'])
  })
})
