/**
 * Round-trip tests for the DB-backed config service. Cover the diff
 * behaviour we'd otherwise only learn about by losing a slot binding
 * in production: provider/model deletion nulls dependent RouterSlots
 * (agent AND subagent), provider renames are delete+create (and warn
 * about it), longContext threshold survives composition, and the agent /
 * subagent routes round-trip independently.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import { applyUiConfig, composeUiConfig, ensureRouterSlots } from '../../src/services/config'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

// HOME and DATABASE_URL are redirected by __tests__/setup.ts (preload),
// so CONFIG_FILE points at a tmp dir and the DB writes hit the test DB.

describe.skipIf(!HAS_DB)('configService', () => {
  beforeEach(async () => {
    await resetDbTables()
    await ensureRouterSlots()
  })

  afterAll(async () => {
    await teardownPrisma()
  })

  test('apply then compose round-trips Providers and Router (with a haiku rule on default)', async () => {
    // The former `background` scenario is now expressed as a predicated
    // rule on the `default` route's rules[] — this asserts a rule with
    // a `requestedModel` glob predicate survives the round-trip.
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v2',
          api_key: 'sk-x',
          auth_mode: 'api_key',
          models: ['gpt-5', 'gpt-5-nano']
        }
      ],
      Router: {
        default: {
          agent: {
            primary: 'openai,gpt-5',
            fallbacks: [],
            rules: [
              {
                name: 'haiku (like background)',
                when: { requestedModel: '*haiku*' },
                target: 'openai,gpt-5-nano'
              }
            ]
          },
          subagent: {}
        },
        longContext: { agent: { primary: 'openai,gpt-5' }, subagent: {}, threshold: 60_000 }
      }
    })

    const ui = await composeUiConfig()
    expect(ui.Providers).toHaveLength(1)
    expect(ui.Providers[0].name).toBe('openai')
    expect(ui.Providers[0].models.sort()).toEqual(['gpt-5', 'gpt-5-nano'])
    expect(ui.Router.default.agent.primary).toBe('openai,gpt-5')
    expect(ui.Router.default.agent.rules).toEqual([
      {
        name: 'haiku (like background)',
        when: { requestedModel: '*haiku*' },
        target: 'openai,gpt-5-nano'
      }
    ])
    expect(ui.Router.longContext.agent.primary).toBe('openai,gpt-5')
    expect(ui.Router.longContext.threshold).toBe(60_000)
    expect(ui.Router.think.agent.primary).toBeNull()
  })

  test('subagent route primary round-trips on the subagentModelId column', async () => {
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v2',
          api_key: 'sk-x',
          auth_mode: 'api_key',
          models: ['gpt-5', 'gpt-5-nano']
        }
      ],
      Router: {
        default: { agent: { primary: 'openai,gpt-5' }, subagent: { primary: 'openai,gpt-5-nano' } }
      }
    })

    const ui = await composeUiConfig()
    expect(ui.Router.default.agent.primary).toBe('openai,gpt-5')
    expect(ui.Router.default.subagent.primary).toBe('openai,gpt-5-nano')
  })

  test('agent and subagent fallback chains round-trip independently', async () => {
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v2',
          api_key: 'sk-x',
          auth_mode: 'api_key',
          models: ['gpt-5', 'gpt-5-nano']
        },
        {
          name: 'anthropic',
          api_base_url: 'https://api.anthropic.com',
          api_key: 'sk-y',
          auth_mode: 'api_key',
          models: ['claude-sonnet-4-6']
        }
      ],
      Router: {
        default: {
          // Agent primary on openai, agent fallback on a DIFFERENT provider.
          agent: { primary: 'openai,gpt-5', fallbacks: ['anthropic,claude-sonnet-4-6'] },
          // Subagent primary on anthropic, subagent fallback on openai.
          subagent: { primary: 'anthropic,claude-sonnet-4-6', fallbacks: ['openai,gpt-5'] }
        }
      }
    })

    const ui = await composeUiConfig()
    expect(ui.Router.default.agent.fallbacks).toEqual(['anthropic,claude-sonnet-4-6'])
    expect(ui.Router.default.subagent.fallbacks).toEqual(['openai,gpt-5'])
  })

  test('a Router payload omitting the subagent route parses and leaves it unset', async () => {
    // A partial save touching only the agent route must NOT 400/500 — the
    // subagent route defaults to an empty target and round-trips as null.
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v2',
          api_key: 'sk-x',
          auth_mode: 'api_key',
          models: ['gpt-5']
        }
      ],
      Router: { default: { agent: { primary: 'openai,gpt-5' } } }
    })

    const ui = await composeUiConfig()
    expect(ui.Router.default.agent.primary).toBe('openai,gpt-5')
    expect(ui.Router.default.subagent.primary).toBeNull()
    expect(ui.Router.default.subagent.fallbacks).toEqual([])
  })

  test('per-slot fallbacks round-trip and unknown models are dropped with a warning', async () => {
    const result = await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v2',
          api_key: 'sk-x',
          auth_mode: 'api_key',
          models: ['gpt-5', 'gpt-5-nano']
        },
        {
          name: 'anthropic',
          api_base_url: 'https://api.anthropic.com',
          api_key: 'sk-y',
          auth_mode: 'api_key',
          models: ['claude-sonnet-4-6']
        }
      ],
      Router: {
        // Same-provider fallbacks are allowed now (per-model exhaustion
        // tracking makes them useful for intra-account rescue). The
        // fallback list here includes one cross-provider entry and one
        // unknown-model entry so only the unknown one gets dropped.
        default: {
          agent: { primary: 'openai,gpt-5', fallbacks: ['anthropic,claude-sonnet-4-6', 'anthropic,does-not-exist'] },
          subagent: {}
        }
      }
    })

    expect(result.warnings.some((w) => w.includes('does-not-exist'))).toBe(true)

    const ui = await composeUiConfig()
    expect(ui.Router.default.agent.primary).toBe('openai,gpt-5')
    expect(ui.Router.default.agent.fallbacks).toEqual(['anthropic,claude-sonnet-4-6'])
    expect(ui.Router.think.agent.fallbacks).toEqual([])
  })

  test('removing a model nulls any RouterSlot that referenced it and warns', async () => {
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v2',
          api_key: 'sk-x',
          auth_mode: 'api_key',
          models: ['gpt-5', 'gpt-5-nano']
        }
      ],
      Router: { default: { agent: { primary: 'openai,gpt-5-nano' }, subagent: {} } }
    })

    const result = await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v2',
          api_key: 'sk-x',
          auth_mode: 'api_key',
          models: ['gpt-5']
        }
      ],
      Router: { default: { agent: { primary: 'openai,gpt-5-nano' }, subagent: {} } } // points at a model we just removed
    })

    expect(result.warnings.some((w) => w.includes('gpt-5-nano'))).toBe(true)
    const ui = await composeUiConfig()
    expect(ui.Router.default.agent.primary).toBeNull()
  })

  test('removing a model nulls a subagent-bound RouterSlot and warns', async () => {
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v2',
          api_key: 'sk-x',
          auth_mode: 'api_key',
          models: ['gpt-5', 'gpt-5-nano']
        }
      ],
      Router: { default: { agent: { primary: 'openai,gpt-5' }, subagent: { primary: 'openai,gpt-5-nano' } } }
    })

    const result = await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v2',
          api_key: 'sk-x',
          auth_mode: 'api_key',
          models: ['gpt-5']
        }
      ],
      // subagent still points at the removed model
      Router: { default: { agent: { primary: 'openai,gpt-5' }, subagent: { primary: 'openai,gpt-5-nano' } } }
    })

    expect(result.warnings.some((w) => w.includes('gpt-5-nano'))).toBe(true)
    const ui = await composeUiConfig()
    expect(ui.Router.default.agent.primary).toBe('openai,gpt-5')
    expect(ui.Router.default.subagent.primary).toBeNull()
  })

  test('deleting a provider cascades models and nulls bound slots (agent and subagent)', async () => {
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v2',
          api_key: 'sk-x',
          auth_mode: 'api_key',
          models: ['gpt-5']
        },
        {
          name: 'gemini',
          api_base_url: 'https://generativelanguage.googleapis.com',
          api_key: 'AI-x',
          auth_mode: 'api_key',
          models: ['gemini-2.5-flash']
        }
      ],
      Router: {
        default: { agent: { primary: 'openai,gpt-5' }, subagent: {} },
        webSearch: { agent: { primary: 'gemini,gemini-2.5-flash' }, subagent: { primary: 'gemini,gemini-2.5-flash' } }
      }
    })

    const result = await applyUiConfig({
      // gemini removed
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v2',
          api_key: 'sk-x',
          auth_mode: 'api_key',
          models: ['gpt-5']
        }
      ],
      Router: {
        default: { agent: { primary: 'openai,gpt-5' }, subagent: {} },
        webSearch: { agent: { primary: 'gemini,gemini-2.5-flash' }, subagent: { primary: 'gemini,gemini-2.5-flash' } }
      }
    })

    expect(result.warnings.some((w) => w.includes('gemini'))).toBe(true)
    const ui = await composeUiConfig()
    expect(ui.Providers.map((p) => p.name)).toEqual(['openai'])
    expect(ui.Router.default.agent.primary).toBe('openai,gpt-5')
    expect(ui.Router.webSearch.agent.primary).toBeNull()
    expect(ui.Router.webSearch.subagent.primary).toBeNull()

    const prisma = getPrismaClient()
    const allModels = await prisma.model.findMany({ include: { provider: true } })
    expect(allModels.map((m) => m.provider.name)).toEqual(['openai'])
  })

  test('API_TIMEOUT_MS number is written to disk and read back via composeUiConfig', async () => {
    await applyUiConfig({
      Providers: [],
      Router: {},
      APIKEY: 'test-key',
      API_TIMEOUT_MS: 30000
    })
    const ui = await composeUiConfig()
    expect(ui.API_TIMEOUT_MS).toBe(30000)
  })

  test('API_TIMEOUT_MS is preserved alongside Providers and Router changes', async () => {
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v2',
          api_key: 'sk-x',
          auth_mode: 'api_key',
          models: ['gpt-5']
        }
      ],
      Router: { default: { agent: { primary: 'openai,gpt-5' }, subagent: {} } },
      APIKEY: 'test-key',
      API_TIMEOUT_MS: 45000
    })
    const ui = await composeUiConfig()
    expect(ui.API_TIMEOUT_MS).toBe(45000)
    expect(ui.Router.default.agent.primary).toBe('openai,gpt-5')
  })

  test('omitting API_TIMEOUT_MS from payload preserves the disk value (merge, not overwrite)', async () => {
    // applyUiConfig now merges the incoming envelope on top of the raw
    // disk envelope so a partial POST does not wipe fields it did not
    // send. Previously the second write would drop API_TIMEOUT_MS from
    // disk because writeConfigFile only saw the incoming keys and
    // rewrote the whole file — the same overwrite that used to null
    // APIKEY out of a "single-toggle" POST. Explicit clearing of a
    // scalar envelope field goes through the CRUD endpoint that owns
    // it (or requires a nulling payload) rather than being encoded as
    // "absent from a general /api/config POST".
    await applyUiConfig({ Providers: [], Router: {}, APIKEY: 'test-key', API_TIMEOUT_MS: 30000 })
    await applyUiConfig({ Providers: [], Router: {}, APIKEY: 'test-key' })
    const ui = await composeUiConfig()
    expect(ui.API_TIMEOUT_MS).toBe(30000)
  })

  test('partial POST preserves envelope scalars the payload does not send (APIKEY, PORT, HOST)', async () => {
    // Regression: a curl-style single-key write
    // `POST /api/config {"CROSS_PROVIDER_FALLBACK":true}` used to
    // clobber every other envelope scalar on disk — the disk file was
    // rewritten from just the payload keys — and in particular wiped
    // APIKEY, locking the caller out of the server on the next request.
    await applyUiConfig({
      Providers: [],
      Router: {},
      APIKEY: 'sensitive-key',
      PORT: 3499,
      HOST: '0.0.0.0'
    })
    // Partial POST touching only a novel envelope scalar. Historically
    // this dropped APIKEY / PORT / HOST because the disk file was
    // overwritten with only the incoming keys.
    await applyUiConfig({ CROSS_PROVIDER_FALLBACK: true })
    const ui = await composeUiConfig()
    expect(ui.APIKEY).toBe('sensitive-key')
    expect(ui.PORT).toBe(3499)
    expect(ui.HOST).toBe('0.0.0.0')
    expect(ui.CROSS_PROVIDER_FALLBACK).toBe(true)
  })

  test('LOG_LEVEL change round-trips through apply then compose (no stale env overlay)', async () => {
    // Regression: readConfigFile's env overlay silently reasserts
    // process.env values over disk, and process.env was mirrored from
    // disk at boot but never refreshed on UI writes. As a result a
    // saved LOG_LEVEL was clobbered by the boot-time value on the very
    // next GET, so users saw the field snap back to 'info' on reload.
    await applyUiConfig({ Providers: [], Router: {}, APIKEY: 'test-key', LOG_LEVEL: 'info' })
    await applyUiConfig({ Providers: [], Router: {}, APIKEY: 'test-key', LOG_LEVEL: 'debug' })
    const ui = await composeUiConfig()
    expect(ui.LOG_LEVEL).toBe('debug')
  })

  test('Personas (top-level) and Router.persona round-trip through apply then compose', async () => {
    await applyUiConfig({
      Providers: [],
      Router: { persona: 'pirate' },
      APIKEY: 'test-key',
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
    expect(ui.Router.persona).toBe('pirate')
  })

  test('empty Router.persona clears the active persona (composed as null)', async () => {
    await applyUiConfig({
      Providers: [],
      Router: { persona: 'pirate' },
      APIKEY: 'test-key',
      Personas: [{ name: 'pirate', prompt: 'Talk like a pirate.' }]
    })
    await applyUiConfig({
      Providers: [],
      Router: { persona: '' },
      APIKEY: 'test-key',
      Personas: [{ name: 'pirate', prompt: 'Talk like a pirate.' }]
    })
    const ui = await composeUiConfig()
    expect(ui.Personas).toEqual([{ name: 'pirate', prompt: 'Talk like a pirate.' }])
    expect(ui.Router.persona).toBeNull()
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
      ],
      Router: {}
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
      ],
      Router: {}
    })

    const after = await prisma.subAccount.findUnique({ where: { id: only.id }, select: { enabled: true } })
    expect(after?.enabled).toBe(false)
  })

  test('unknown router scenarios are dropped', async () => {
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v2',
          api_key: 'sk-x',
          auth_mode: 'api_key',
          models: ['gpt-5']
        }
      ],
      Router: {
        default: { agent: { primary: 'openai,gpt-5' }, subagent: {} },
        custom: 'openai,gpt-5'
      }
    })

    const ui = await composeUiConfig()
    expect(ui.Router.default.agent.primary).toBe('openai,gpt-5')
    expect(ui.Router.custom).toBeUndefined()
  })

  test('omitting Providers from a partial save preserves existing providers', async () => {
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v2',
          api_key: 'sk-x',
          auth_mode: 'api_key',
          models: ['gpt-5']
        }
      ],
      Router: { default: { agent: { primary: 'openai,gpt-5' }, subagent: {} } }
    })
    // A save WITHOUT a Providers key must NOT delete the provider — the bug
    // that cascaded a Provider delete all the way to OAuth accounts. Router
    // carries the slots we want to keep (applyRouter clears any scenario
    // absent from a Router it IS given, which is why the editor sends all).
    await applyUiConfig({
      Router: {
        default: { agent: { primary: 'openai,gpt-5' }, subagent: {} },
        webSearch: { agent: { primary: 'openai,gpt-5' }, subagent: {} }
      }
    })
    const ui = await composeUiConfig()
    expect(ui.Providers.map((p) => p.name)).toEqual(['openai'])
    expect(ui.Router.default.agent.primary).toBe('openai,gpt-5')
    expect(ui.Router.webSearch.agent.primary).toBe('openai,gpt-5')
  })

  test('omitting Router from a partial save preserves existing router slots', async () => {
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v2',
          api_key: 'sk-x',
          auth_mode: 'api_key',
          models: ['gpt-5']
        }
      ],
      Router: { default: { agent: { primary: 'openai,gpt-5' }, subagent: {} } }
    })
    // A Providers-only save (no Router key) must NOT clear the router.
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v2',
          api_key: 'sk-x',
          auth_mode: 'api_key',
          models: ['gpt-5', 'gpt-5-nano']
        }
      ]
    })
    const ui = await composeUiConfig()
    expect(ui.Router.default.agent.primary).toBe('openai,gpt-5')
    expect(ui.Providers[0].models.sort()).toEqual(['gpt-5', 'gpt-5-nano'])
  })

  test('provider enabled round-trips through the Provider.enabled column', async () => {
    // This used to live as `providerEnabled: false` inside the
    // `Provider.transformer` JSONB. The promotion to a real column is
    // only safe if the flag still survives apply -> compose, and if the
    // absence of the flag still reads as enabled rather than as null.
    const base = {
      name: 'openai',
      api_base_url: 'https://api.openai.com/v2',
      api_key: 'sk-x',
      auth_mode: 'api_key' as const,
      models: ['gpt-5']
    }
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
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v2',
          api_key: 'sk-x',
          auth_mode: 'api_key',
          models: ['gpt-5'],
          enabled: false
        }
      ]
    })
    const { getEnabledModels } = await import('../../src/services/config/enabled-models')
    expect(await getEnabledModels()).toEqual([])
  })
})
