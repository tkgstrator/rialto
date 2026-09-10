/**
 * A disabled provider or model is unreachable on every path.
 *
 * `Provider.enabled` and `Model.enabled` are the Providers screen's two
 * switches. They used to gate only what `/v1/models` advertised and
 * what the Routing screen offered: a chain entry written before the
 * switch flipped kept routing to it, a passthrough caller naming the
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
import {
  foldTargetEnabled,
  loadRoutableProfile,
  loadRouterPreferences
} from '../../src/services/router-preference-service'
import { getSubAccountTokensForKind } from '../../src/services/subscription-account-sync/read'
import { entry, profileWith } from '../llms/chain-fixture'
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
  scenarioType: 'default',
  primaryModel: 'x',
  isSubagent: false,
  fallbacks: [],
  path: '/v1/messages',
  search: '',
  accountSessionKey: 'anonymous'
})

describe('folding the target switches into the entry (no DB)', () => {
  test('an entry whose target is off reads as disabled on the request path only', () => {
    const editor = profileWith({ 'default.agent': [entry('a,m', true, false), 'a,n'] })
    const routable = foldTargetEnabled(editor)
    expect(editor.entriesByScenario.default.agent[0].enabled).toBe(true)
    expect(routable.entriesByScenario.default.agent[0].enabled).toBe(false)
    expect(routable.entriesByScenario.default.agent[1].enabled).toBe(true)
  })

  test('an entry without the field — a seeded fixture — counts as on', () => {
    const routable = foldTargetEnabled(profileWith({ 'think.agent': ['a,m'] }))
    expect(routable.entriesByScenario.think.agent[0].enabled).toBe(true)
  })
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

  test('the chain reports the target switch separately, and the request path folds it', async () => {
    await seedProviders()
    const prisma = getPrismaClient()
    const live = await prisma.routerPreferenceProfile.upsert({
      where: { key: 'live' },
      update: {},
      create: { key: 'live' }
    })
    const models = await prisma.model.findMany({ include: { provider: true } })
    const byTarget = new Map(models.map((m) => [`${m.provider.name},${m.name}`, m.id]))
    const idOf = (target: string): string => {
      const id = byTarget.get(target)
      if (id === undefined) throw new Error(`fixture did not seed ${target}`)
      return id
    }
    // Written directly rather than through applyRouterPreferences: the
    // apply path resolves targets by name and would happily store these
    // too, but the point is what the READ reports about them.
    const targets = ['anthropic,claude-sonnet-5', 'openai,gpt-5-mini', 'openai,gpt-5']
    await prisma.routerPreferenceEntry.createMany({
      data: targets.map((target, idx) => ({
        profileId: live.id,
        scenario: 'default',
        kind: 'agent',
        priority: idx + 1,
        modelId: idOf(target)
      }))
    })

    const editor = await loadRouterPreferences()
    const lane = editor.entriesByScenario.default.agent
    expect(lane.map((e) => [e.target, e.enabled, e.targetEnabled])).toEqual([
      ['anthropic,claude-sonnet-5', true, false],
      ['openai,gpt-5-mini', true, false],
      ['openai,gpt-5', true, true]
    ])

    const routable = await loadRoutableProfile()
    expect(routable.entriesByScenario.default.agent.map((e) => e.enabled)).toEqual([false, false, true])
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
