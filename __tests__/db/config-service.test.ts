/**
 * Round-trip tests for the DB-backed config service. Cover the diff
 * behaviour we'd otherwise only learn about in production: provider /
 * model deletion cascades to the chain entries naming them (and says
 * so), partial saves preserve what they did not send, the active persona
 * round-trips as a top-level key, and the keys a retired feature used to
 * accept are dropped rather than stored.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import { applyUiConfig, composeUiConfig, ensurePreferenceProfile } from '../../src/services/config'
import { readRawConfigFile, writeConfigFile } from '../../src/services/config/envelope'
import { applyRouterPreferences, loadRouterPreferences } from '../../src/services/router-preference-service'
import { profileWith } from '../llms/chain-fixture'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

// HOME and DATABASE_URL are redirected by __tests__/setup.ts (preload),
// so CONFIG_FILE points at a tmp dir and the DB writes hit the test DB.

const openai = (models: string[]) => ({
  name: 'openai',
  api_base_url: 'https://api.openai.com/v2',
  api_key: 'sk-x',
  auth_mode: 'api_key' as const,
  models
})

const anthropic = (models: string[]) => ({
  name: 'anthropic',
  api_base_url: 'https://api.anthropic.com',
  api_key: 'sk-y',
  auth_mode: 'api_key' as const,
  models
})

describe.skipIf(!HAS_DB)('configService', () => {
  beforeEach(async () => {
    await resetDbTables()
    await ensurePreferenceProfile()
    // The envelope lives on disk (a tmp home shared by every test in the
    // process) and is not reset by the table truncate; start each case
    // from a bare file so no case reads what a neighbour wrote.
    await writeConfigFile({ PORT: 3456, Providers: [] })
  })

  afterAll(async () => {
    await teardownPrisma()
  })

  test('apply then compose round-trips Providers', async () => {
    await applyUiConfig({ Providers: [openai(['gpt-5', 'gpt-5-nano'])] })
    const ui = await composeUiConfig()
    expect(ui.Providers).toHaveLength(1)
    expect(ui.Providers[0].name).toBe('openai')
    expect(ui.Providers[0].models.sort()).toEqual(['gpt-5', 'gpt-5-nano'])
  })

  test('removing a model warns about the chain entries that cascade away with it', async () => {
    await applyUiConfig({ Providers: [openai(['gpt-5', 'gpt-5-nano'])] })
    await applyRouterPreferences(profileWith({ 'default.agent': ['openai,gpt-5-nano', 'openai,gpt-5'] }))

    const result = await applyUiConfig({ Providers: [openai(['gpt-5'])] })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('Removed 1 chain entry')
    expect(result.warnings[0]).toContain('gpt-5-nano')
    expect(result.warnings[0]).toContain('live/default/agent')

    const after = await loadRouterPreferences()
    expect(after.entriesByScenario.default.agent.map((e) => e.target)).toEqual(['openai,gpt-5'])
  })

  test('deleting a provider cascades models and warns per profile, scenario and lane', async () => {
    await applyUiConfig({ Providers: [openai(['gpt-5']), anthropic(['claude-sonnet-4-6'])] })
    await applyRouterPreferences(
      profileWith({
        'default.agent': ['openai,gpt-5', 'anthropic,claude-sonnet-4-6'],
        'webSearch.agent': ['anthropic,claude-sonnet-4-6'],
        'webSearch.subagent': ['anthropic,claude-sonnet-4-6']
      })
    )

    // anthropic removed
    const result = await applyUiConfig({ Providers: [openai(['gpt-5'])] })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('Removed 3 chain entries')
    expect(result.warnings[0]).toContain('deleted provider "anthropic"')
    expect(result.warnings[0]).toContain('live/webSearch/subagent')

    const ui = await composeUiConfig()
    expect(ui.Providers.map((p) => p.name)).toEqual(['openai'])
    const after = await loadRouterPreferences()
    expect(after.entriesByScenario.default.agent.map((e) => e.target)).toEqual(['openai,gpt-5'])
    expect(after.entriesByScenario.webSearch.agent).toEqual([])

    const prisma = getPrismaClient()
    const allModels = await prisma.model.findMany({ include: { provider: true } })
    expect(allModels.map((m) => m.provider.name)).toEqual(['openai'])
  })

  test('a model removal no chain names produces no warning', async () => {
    await applyUiConfig({ Providers: [openai(['gpt-5', 'gpt-5-nano'])] })
    const result = await applyUiConfig({ Providers: [openai(['gpt-5'])] })
    expect(result.warnings).toEqual([])
  })

  test('API_TIMEOUT_MS number is written to disk and read back via composeUiConfig', async () => {
    await applyUiConfig({ Providers: [], API_TIMEOUT_MS: 30000 })
    const ui = await composeUiConfig()
    expect(ui.API_TIMEOUT_MS).toBe(30000)
  })

  test('API_TIMEOUT_MS is preserved alongside Providers changes', async () => {
    await applyUiConfig({ Providers: [openai(['gpt-5'])], API_TIMEOUT_MS: 45000 })
    const ui = await composeUiConfig()
    expect(ui.API_TIMEOUT_MS).toBe(45000)
    expect(ui.Providers[0].name).toBe('openai')
  })

  test('omitting API_TIMEOUT_MS from payload preserves the disk value (merge, not overwrite)', async () => {
    // applyUiConfig merges the incoming envelope on top of the raw disk
    // envelope so a partial POST does not wipe fields it did not send.
    // Previously the second write would drop API_TIMEOUT_MS from disk
    // because writeConfigFile only saw the incoming keys and rewrote
    // the whole file — the same overwrite that used to wipe every other
    // scalar out of a "single-toggle" POST.
    await applyUiConfig({ Providers: [], API_TIMEOUT_MS: 30000 })
    await applyUiConfig({ Providers: [] })
    const ui = await composeUiConfig()
    expect(ui.API_TIMEOUT_MS).toBe(30000)
  })

  test('partial POST preserves envelope scalars the payload does not send (PORT, HOST)', async () => {
    // Regression: a curl-style single-key write used to clobber every
    // other envelope scalar on disk — the disk file was rewritten from
    // just the payload keys.
    await applyUiConfig({ Providers: [], PORT: 3499, HOST: '0.0.0.0' })
    // Partial POST touching only one other envelope scalar.
    await applyUiConfig({ ROUTING_SCHEDULER_INTERVAL_MS: 120_000 })
    const ui = await composeUiConfig()
    expect(ui.PORT).toBe(3499)
    expect(ui.HOST).toBe('0.0.0.0')
    expect(ui.ROUTING_SCHEDULER_INTERVAL_MS).toBe(120_000)
  })

  test('LOG_LEVEL change round-trips through apply then compose (no stale env overlay)', async () => {
    // Regression: readConfigFile's env overlay silently reasserts
    // process.env values over disk, and process.env was mirrored from
    // disk at boot but never refreshed on UI writes. As a result a
    // saved LOG_LEVEL was clobbered by the boot-time value on the very
    // next GET, so users saw the field snap back to 'info' on reload.
    await applyUiConfig({ Providers: [], LOG_LEVEL: 'info' })
    await applyUiConfig({ Providers: [], LOG_LEVEL: 'debug' })
    const ui = await composeUiConfig()
    expect(ui.LOG_LEVEL).toBe('debug')
  })

  test('Personas and the top-level ActivePersona round-trip through apply then compose', async () => {
    await applyUiConfig({
      Providers: [],
      ActivePersona: 'pirate',
      Personas: [
        { name: 'pirate', prompt: 'Talk like a pirate.' },
        { name: 'lawyer', prompt: 'Be precise and cite statutes.' }
      ]
    })
    const ui = await composeUiConfig()
    expect(ui.Personas).toEqual([
      { name: 'pirate', prompt: 'Talk like a pirate.' },
      { name: 'lawyer', prompt: 'Be precise and cite statutes.' }
    ])
    expect(ui.ActivePersona).toBe('pirate')
  })

  test('an empty ActivePersona clears the active persona (composed as null), and null does too', async () => {
    const personas = [{ name: 'pirate', prompt: 'Talk like a pirate.' }]
    await applyUiConfig({ Providers: [], ActivePersona: 'pirate', Personas: personas })
    await applyUiConfig({ Providers: [], ActivePersona: '', Personas: personas })
    expect((await composeUiConfig()).ActivePersona).toBeNull()

    await applyUiConfig({ ActivePersona: 'pirate' })
    expect((await composeUiConfig()).ActivePersona).toBe('pirate')
    await applyUiConfig({ ActivePersona: null })
    expect((await composeUiConfig()).ActivePersona).toBeNull()
  })

  test('a save that omits ActivePersona leaves the selection alone', async () => {
    await applyUiConfig({ ActivePersona: 'pirate', Personas: [{ name: 'pirate', prompt: 'Arr.' }] })
    await applyUiConfig({ Providers: [openai(['gpt-5'])] })
    expect((await composeUiConfig()).ActivePersona).toBe('pirate')
  })

  test('a fresh install composes ActivePersona as null, never undefined', async () => {
    const ui = await composeUiConfig()
    expect(ui.ActivePersona).toBeNull()
  })

  test('retired keys are dropped with a warning and never written', async () => {
    const result = await applyUiConfig({
      LOG_LEVEL: 'debug',
      APIKEY: 'k',
      Router: { default: { agent: { primary: 'openai,gpt-5' } }, persona: 'pirate' },
      CUSTOM_ROUTER_PATH: '/tmp/router.js',
      LiveRoutingName: 'Work',
      CROSS_PROVIDER_FALLBACK: true
    })
    const retired = ['APIKEY', 'Router', 'CUSTOM_ROUTER_PATH', 'LiveRoutingName', 'CROSS_PROVIDER_FALLBACK']
    expect(result.warnings).toHaveLength(1)
    for (const key of retired) {
      expect(result.warnings[0]).toContain(key)
    }

    const raw = await readRawConfigFile()
    // The live scalar beside them still lands.
    expect(raw.LOG_LEVEL).toBe('debug')
    for (const key of retired) {
      expect(key in raw).toBe(false)
    }
    // The persona nested under the retired key is not lifted either.
    expect('ActivePersona' in raw).toBe(false)

    const ui = await composeUiConfig()
    for (const key of retired) {
      expect(key in ui).toBe(false)
    }
  })

  test('a retired key left on disk by an older build is hidden from the wire and pruned on the next save', async () => {
    await writeConfigFile({
      PORT: 3456,
      APIKEY: 'k',
      Providers: [],
      Router: { default: { agent: { primary: 'openai,gpt-5', fallbacks: [], rules: [] } } },
      CROSS_PROVIDER_FALLBACK: true,
      LiveRoutingName: 'Work'
    })
    const before = await composeUiConfig()
    expect('Router' in before).toBe(false)
    expect('CROSS_PROVIDER_FALLBACK' in before).toBe(false)
    // For APIKEY the stale copy is a plaintext secret, which must not
    // reach GET /api/config.
    expect('APIKEY' in before).toBe(false)

    await applyUiConfig({ LOG_LEVEL: 'debug' })
    const raw = await readRawConfigFile()
    expect(raw.LOG_LEVEL).toBe('debug')
    expect(raw.PORT).toBe(3456)
    expect('APIKEY' in raw).toBe(false)
    expect('Router' in raw).toBe(false)
    expect('CROSS_PROVIDER_FALLBACK' in raw).toBe(false)
    expect('LiveRoutingName' in raw).toBe(false)
  })

  // Toggling an account used to have a second effect: it moved the
  // provider's `activeSubscriptionAccountId` binding, promoting a peer or
  // nulling the slot. That binding is gone — every enabled account is a
  // candidate — so the toggle now writes exactly one thing.
  test('disabling one subscription account leaves its peers alone', async () => {
    const prisma = getPrismaClient()
    const { AuthMode } = await import('../../src/generated/prisma/client')
    const provider = await prisma.provider.create({
      data: {
        name: 'claude-code',
        apiBaseUrl: 'https://api.anthropic.com',
        authMode: AuthMode.subscription
      }
    })
    const first = await prisma.subAccount.create({
      data: {
        providerId: provider.id,
        sourcePath: 'oauth:claude:a',
        label: 'claude-code:web-oauth',
        enabled: true,
        plan: 'claude_max'
      }
    })
    const spare = await prisma.subAccount.create({
      data: {
        providerId: provider.id,
        sourcePath: 'oauth:claude:b',
        label: 'claude-code:web-oauth',
        enabled: true,
        plan: 'claude_max'
      }
    })

    await applyUiConfig({
      Providers: [
        {
          name: 'claude-code',
          api_base_url: 'https://api.anthropic.com',
          api_key: '',
          auth_mode: 'subscription',
          models: [],
          subscription_accounts: [
            { id: first.id, enabled: false },
            { id: spare.id, enabled: true }
          ]
        }
      ]
    })

    const after = await prisma.subAccount.findMany({
      where: { providerId: provider.id },
      select: { id: true, enabled: true },
      orderBy: { sourcePath: 'asc' }
    })
    expect(after).toEqual([
      { id: first.id, enabled: false },
      { id: spare.id, enabled: true }
    ])
  })

  test('disabling the last enabled subscription account is allowed', async () => {
    const prisma = getPrismaClient()
    const { AuthMode } = await import('../../src/generated/prisma/client')
    const provider = await prisma.provider.create({
      data: {
        name: 'claude-code',
        apiBaseUrl: 'https://api.anthropic.com',
        authMode: AuthMode.subscription
      }
    })
    const only = await prisma.subAccount.create({
      data: {
        providerId: provider.id,
        sourcePath: 'oauth:claude:only',
        label: 'claude-code:web-oauth',
        enabled: true,
        plan: 'claude_max'
      }
    })

    await applyUiConfig({
      Providers: [
        {
          name: 'claude-code',
          api_base_url: 'https://api.anthropic.com',
          api_key: '',
          auth_mode: 'subscription',
          models: [],
          subscription_accounts: [{ id: only.id, enabled: false }]
        }
      ]
    })

    const after = await prisma.subAccount.findUnique({ where: { id: only.id }, select: { enabled: true } })
    expect(after?.enabled).toBe(false)
  })

  test('omitting Providers from a partial save preserves existing providers', async () => {
    await applyUiConfig({ Providers: [openai(['gpt-5'])] })
    // A save WITHOUT a Providers key must NOT delete the provider — the bug
    // that cascaded a Provider delete all the way to OAuth accounts.
    await applyUiConfig({ LOG_LEVEL: 'debug' })
    const ui = await composeUiConfig()
    expect(ui.Providers.map((p) => p.name)).toEqual(['openai'])
  })

  test('a Providers-only save leaves the chain alone', async () => {
    await applyUiConfig({ Providers: [openai(['gpt-5'])] })
    await applyRouterPreferences(profileWith({ 'default.agent': ['openai,gpt-5'] }))
    await applyUiConfig({ Providers: [openai(['gpt-5', 'gpt-5-nano'])] })
    const after = await loadRouterPreferences()
    expect(after.entriesByScenario.default.agent.map((e) => e.target)).toEqual(['openai,gpt-5'])
    const ui = await composeUiConfig()
    expect(ui.Providers[0].models.sort()).toEqual(['gpt-5', 'gpt-5-nano'])
  })

  test('provider enabled round-trips through the Provider.enabled column', async () => {
    // This used to live as `providerEnabled: false` inside the
    // `Provider.transformer` JSONB. The promotion to a real column is
    // only safe if the flag still survives apply -> compose, and if the
    // absence of the flag still reads as enabled rather than as null.
    const base = openai(['gpt-5'])
    await applyUiConfig({ Providers: [{ ...base, enabled: false }] })
    const disabled = await composeUiConfig()
    expect(disabled.Providers[0].enabled).toBe(false)

    await applyUiConfig({ Providers: [{ ...base, enabled: true }] })
    const enabled = await composeUiConfig()
    expect(enabled.Providers[0].enabled).toBe(true)

    // A payload that never mentions `enabled` must not silently disable
    // the provider — the old blob's absence meant "on".
    await applyUiConfig({ Providers: [base] })
    const unspecified = await composeUiConfig()
    expect(unspecified.Providers[0].enabled).toBe(true)
  })

  test('a disabled provider keeps its models out of the routable set', async () => {
    // The reason the flag is worth a column: getEnabledModels filters on
    // it, and it used to have to parse JSON to do so.
    await applyUiConfig({ Providers: [{ ...openai(['gpt-5']), enabled: false }] })
    const { getEnabledModels } = await import('../../src/services/config/enabled-models')
    expect(await getEnabledModels()).toEqual([])
  })
})
