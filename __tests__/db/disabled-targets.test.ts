/**
 * A disabled provider or model is unreachable on every path.
 *
 * `Provider.enabled` and `Model.enabled` are the Providers screen's two
 * switches. They used to gate only what `/v1/models` advertised and
 * what the Routing screen offered: a route written before the switch
 * flipped kept routing to it, a passthrough caller naming the
 * pair by hand was dispatched, and a disabled subscription provider's
 * accounts still fed the per-request picker. These pin the door shut
 * on all of them.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createCipheriv, randomBytes } from 'node:crypto'
import { resolveInvocationForModel } from '../../src/api/v1/invocation'
import type { RoutePlan } from '../../src/api/v1/route-plan'
import { getPrismaClient } from '../../src/db/client'
import { getLlmsContext, resetLlmsContext } from '../../src/llms'
import { AnthropicTransformer } from '../../src/llms/transformers/anthropic'
import { applyUiConfig } from '../../src/services/config'
import { getSubAccountTokensForKind } from '../../src/services/subscription-account-sync/read'
import { setTierAlias } from '../../src/services/tier-alias-service'
import { loadTierProfileView, saveTierProfile } from '../../src/services/tier-route-service'
import { profileWith } from '../llms/tier-fixture'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

const TEST_KEY_HEX = 'ab'.repeat(32)

// Same iv.tag.body format encryptString() produces, so SubAccount rows
// can be planted without the OAuth flow.
const encryptForTest = (plain: string): string => {
  const key = Buffer.from(TEST_KEY_HEX, 'hex')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`
}

const plan = (): RoutePlan => ({
  routedBody: { model: 'x' },
  headers: {},
  transformersByName: new Map(),
  defaultTransformer: new AnthropicTransformer(),
  route: 'default',
  primaryModel: 'x',
  isSubagent: false,
  fallbacks: [],
  path: '/v1/messages',
  search: '',
  accountSessionKey: 'anonymous'
})

describe.skipIf(!HAS_DB)('disabled targets (DB)', () => {
  beforeEach(async () => {
    await resetDbTables()
    resetLlmsContext()
    process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY = TEST_KEY_HEX
  })

  afterEach(() => {
    delete process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY
    resetLlmsContext()
  })

  afterAll(async () => {
    await teardownPrisma()
  })

  const seedProviders = async () => {
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v1',
          api_key: 'sk-openai',
          auth_mode: 'api_key',
          models: ['gpt-5', 'gpt-5-mini'],
          transformer: { _disabledModels: ['gpt-5-mini'] }
        },
        {
          name: 'anthropic',
          api_base_url: 'https://api.anthropic.com/v1/messages',
          api_key: 'sk-ant',
          auth_mode: 'api_key',
          models: ['claude-sonnet-5'],
          enabled: false
        }
      ]
    })
  }

  test('a route reports its target switch apart from its own, so the selector skips it', async () => {
    await seedProviders()
    const prisma = getPrismaClient()
    // Aliases written directly: setTierAlias switches the model it points
    // at back on, and the point is what the read reports about a target
    // that is off.
    const models = await prisma.model.findMany({ include: { provider: true } })
    const idOf = (provider: string, model: string): { providerId: string; modelId: string } => {
      const row = models.find((m) => m.provider.name === provider && m.name === model)
      if (row === undefined) throw new Error(`fixture did not seed ${provider},${model}`)
      return { providerId: row.providerId, modelId: row.id }
    }
    // Saving the providers already aliased the Claude-named models by
    // name; these replace that with the exact pairs under test.
    await prisma.providerTierAlias.deleteMany({})
    await prisma.providerTierAlias.createMany({
      data: [
        { ...idOf('anthropic', 'claude-sonnet-5'), tier: 'sonnet' },
        { ...idOf('openai', 'gpt-5-mini'), tier: 'haiku' },
        { ...idOf('openai', 'gpt-5'), tier: 'sonnet' }
      ]
    })
    await saveTierProfile(
      'live',
      profileWith({
        default: {
          agent: [
            { provider: 'anthropic', targetTier: 'sonnet', enabled: true },
            { provider: 'openai', targetTier: 'haiku', enabled: true },
            { provider: 'openai', targetTier: 'sonnet', enabled: true }
          ]
        }
      })
    )

    const view = await loadTierProfileView('live')
    expect(view.routes.default.agent.map((r) => [r.provider, r.enabled, r.resolved?.targetEnabled])).toEqual([
      ['anthropic', true, false],
      ['openai', true, false],
      ['openai', true, true]
    ])
  })

  test('promoting a switched-off model through its alias switches it on', async () => {
    await seedProviders()
    const outcome = await setTierAlias('openai', 'haiku', 'gpt-5-mini')
    expect(outcome).toEqual({ ok: true, enabledModel: true })
    const row = await getPrismaClient().model.findFirst({ where: { name: 'gpt-5-mini' } })
    expect(row?.enabled).toBe(true)
  })

  test('the registry holds only enabled models of enabled providers, so invocation refuses the rest', async () => {
    await seedProviders()
    const ctx = await getLlmsContext()
    expect(ctx.providers.get('anthropic')).toBeUndefined()
    expect(ctx.providers.get('openai')?.models).toEqual(['gpt-5'])

    expect(resolveInvocationForModel(plan(), 'openai,gpt-5', ctx)).not.toBeNull()
    expect(resolveInvocationForModel(plan(), 'openai,gpt-5-mini', ctx)).toBeNull()
    expect(resolveInvocationForModel(plan(), 'anthropic,claude-sonnet-5', ctx)).toBeNull()
  })

  test('a bare model hosted only by a disabled provider or as a disabled model resolves to nothing', async () => {
    await seedProviders()
    const ctx = await getLlmsContext()
    expect(resolveInvocationForModel(plan(), 'claude-sonnet-5', ctx)).toBeNull()
    expect(resolveInvocationForModel(plan(), 'gpt-5-mini', ctx)).toBeNull()
    expect(resolveInvocationForModel(plan(), 'gpt-5', ctx)?.provider.name).toBe('openai')
  })

  test('the per-request account pool ignores a disabled subscription provider', async () => {
    const prisma = getPrismaClient()
    const enabled = await prisma.provider.create({
      data: { name: 'claude-code', apiBaseUrl: 'https://api.anthropic.com', authMode: 'subscription', enabled: true }
    })
    const disabled = await prisma.provider.create({
      data: { name: 'claude-code-2', apiBaseUrl: 'https://api.anthropic.com', authMode: 'subscription', enabled: false }
    })
    await prisma.subAccount.createMany({
      data: [
        {
          providerId: enabled.id,
          sourcePath: 'oauth:claude:on',
          label: 'on',
          enabled: true,
          accessTokenEnc: encryptForTest('token-on')
        },
        {
          providerId: disabled.id,
          sourcePath: 'oauth:claude:off',
          label: 'off',
          enabled: true,
          accessTokenEnc: encryptForTest('token-off')
        }
      ]
    })
    const pool = await getSubAccountTokensForKind('claude')
    expect(pool.map((a) => a.accessToken)).toEqual(['token-on'])
  })
})
