import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import { getProviders } from '../../src/services/config'
import { captureModelCapabilities } from '../../src/services/model-capability-service'
import { encryptionKey, encryptString } from '../../src/services/subscription-account-sync/crypto'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

const TEST_KEY_HEX = 'cd'.repeat(32)

type Sent = { thinking?: { type: string }; output_config?: { effort: string } }

// Each vendor as it answered on 2026-09-29, trimmed to the fields read.
const effortCaps = (levels: readonly string[]) =>
  Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'max'].map((l) => [l, { supported: levels.includes(l) }]))
const claudeModels = {
  data: [
    {
      id: 'claude-sonnet-5-5',
      max_input_tokens: 1_000_000,
      capabilities: { effort: { supported: true, ...effortCaps(['low', 'medium', 'high', 'xhigh', 'max']) } }
    },
    {
      id: 'claude-sonnet-5',
      max_input_tokens: 1_000_000,
      capabilities: { effort: { supported: true, ...effortCaps(['low', 'medium', 'high', 'xhigh', 'max']) } }
    }
  ],
  has_more: false
}
const codexModels = {
  models: [
    {
      slug: 'gpt-6-sol',
      context_window: 272_000,
      max_context_window: 872_000,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }]
    }
  ]
}
// Sonnet 5.5 refuses `disabled` and takes `between_tools` at high or below;
// Sonnet 5 is the reverse.
const countTokens = (model: string, sent: Sent): number => {
  const type = sent.thinking?.type
  const effort = sent.output_config?.effort
  if (type === undefined) return 200
  if (model === 'claude-sonnet-5') return type === 'disabled' ? 200 : 400
  if (type === 'disabled') return 400
  return effort === 'xhigh' || effort === 'max' ? 400 : 200
}

function vendors(opts: { countTokensStatus?: (model: string, sent: Sent) => number } = {}) {
  const calls: string[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push(url)
    if (url.startsWith('https://api.anthropic.com/v1/models')) return Response.json(claudeModels)
    if (url.startsWith('https://chatgpt.com/backend-api/codex/models')) return Response.json(codexModels)
    if (url === 'https://api.anthropic.com/v1/messages/count_tokens') {
      const body = JSON.parse(String(init?.body))
      const status = opts.countTokensStatus === undefined ? countTokens : opts.countTokensStatus
      return new Response('{}', { status: status(body.model, body) })
    }
    return new Response('not found', { status: 404 })
  }
  return { fetchImpl, calls }
}

async function seed(): Promise<void> {
  const prisma = getPrismaClient()
  const key = encryptionKey()
  const claude = await prisma.provider.create({
    data: { name: 'claude-code', apiBaseUrl: 'https://api.anthropic.com/v1/messages', authMode: 'subscription' }
  })
  const codex = await prisma.provider.create({
    data: { name: 'codex', apiBaseUrl: 'https://chatgpt.com/backend-api/codex', authMode: 'subscription' }
  })
  await prisma.subAccount.createMany({
    data: [
      {
        providerId: claude.id,
        sourcePath: 'oauth:claude:a',
        label: 'a',
        enabled: true,
        accessTokenEnc: encryptString('claude-token', key)
      },
      {
        providerId: codex.id,
        sourcePath: 'oauth:codex:a',
        label: 'a',
        enabled: true,
        accessTokenEnc: encryptString('codex-token', key)
      }
    ]
  })
  await prisma.model.createMany({
    data: [
      { providerId: claude.id, name: 'claude-sonnet-5-5', enabled: true, contextWindow: 200_000 },
      { providerId: claude.id, name: 'claude-sonnet-5', enabled: false },
      { providerId: claude.id, name: 'claude-retired', enabled: true },
      { providerId: codex.id, name: 'gpt-6-sol', enabled: false, contextWindow: 1_050_000 }
    ]
  })
}

const capabilityOf = (name: string) => getPrismaClient().modelCapability.findFirst({ where: { model: { name } } })
const contextOf = async (name: string) =>
  (await getPrismaClient().model.findFirstOrThrow({ where: { name } })).contextWindow

describe.skipIf(!HAS_DB)('model capabilities, read once', () => {
  beforeAll(() => {
    process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY = TEST_KEY_HEX
  })
  afterAll(async () => {
    delete process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY
    await teardownPrisma()
  })
  beforeEach(async () => {
    await resetDbTables()
    await seed()
  })

  test('records every listed model and probes thinking only on switched-on Claude Code models', async () => {
    const { fetchImpl } = vendors()
    await captureModelCapabilities(fetchImpl)

    // The subscription's own window replaces the scraped API figure.
    expect(await contextOf('claude-sonnet-5-5')).toBe(1_000_000)
    expect(await contextOf('gpt-6-sol')).toBe(872_000)
    expect((await capabilityOf('gpt-6-sol'))?.efforts).toEqual(['low', 'ultra'])

    const on = await capabilityOf('claude-sonnet-5-5')
    expect(on?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(on?.thinkingProbedAt).not.toBeNull()
    expect(on?.thinkingDisabled).toEqual([])
    expect(on?.thinkingBetweenTools).toEqual(['default', 'low', 'medium', 'high'])

    // Listed but switched off: list facts yes, the costlier probe no.
    const off = await capabilityOf('claude-sonnet-5')
    expect(off?.efforts).toHaveLength(5)
    expect(off?.thinkingProbedAt).toBeNull()

    // Not in the list: left unrecorded, to be asked about again.
    expect(await capabilityOf('claude-retired')).toBeNull()
  })

  test('never asks again about what it has recorded', async () => {
    await captureModelCapabilities(vendors().fetchImpl)
    await getPrismaClient().model.updateMany({ where: { name: 'claude-sonnet-5-5' }, data: { contextWindow: 123 } })
    await getPrismaClient().model.deleteMany({ where: { name: 'claude-retired' } })
    const again = vendors()
    await captureModelCapabilities(again.fetchImpl)
    expect(again.calls).toEqual([])
    expect(await contextOf('claude-sonnet-5-5')).toBe(123)
  })

  test('switching a model on later probes it on the next pass', async () => {
    await captureModelCapabilities(vendors().fetchImpl)
    await getPrismaClient().model.updateMany({ where: { name: 'claude-sonnet-5' }, data: { enabled: true } })
    await captureModelCapabilities(vendors().fetchImpl)
    const probed = await capabilityOf('claude-sonnet-5')
    expect(probed?.thinkingDisabled).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(probed?.thinkingBetweenTools).toEqual([])
  })

  test('an inconclusive probe is retried rather than recorded', async () => {
    const limited = vendors({ countTokensStatus: (_model, sent) => (sent.thinking === undefined ? 200 : 429) })
    await captureModelCapabilities(limited.fetchImpl)
    expect((await capabilityOf('claude-sonnet-5-5'))?.thinkingProbedAt).toBeNull()
    await captureModelCapabilities(vendors().fetchImpl)
    expect((await capabilityOf('claude-sonnet-5-5'))?.thinkingBetweenTools).toEqual([
      'default',
      'low',
      'medium',
      'high'
    ])
  })

  test('the provider projection carries what was recorded', async () => {
    await captureModelCapabilities(vendors().fetchImpl)
    const claude = (await getProviders()).find((p) => p.name === 'claude-code')
    expect(claude?.modelSupportedEfforts?.['claude-sonnet-5-5']).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(claude?.modelThinkingOff).toEqual({
      'claude-sonnet-5-5': { disabled: [], betweenTools: ['default', 'low', 'medium', 'high'] }
    })
    const codex = (await getProviders()).find((p) => p.name === 'codex')
    expect(codex?.modelSupportedEfforts).toEqual({ 'gpt-6-sol': ['low', 'ultra'] })
    expect(codex?.modelThinkingOff).toBeUndefined()
  })
})
