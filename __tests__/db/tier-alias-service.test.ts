/**
 * Provider tiers.
 *
 * Pinned: a tier some model names follows the newest switched-on one — a
 * model that shows up later is a candidate marked new, and only switching
 * it on moves the route; a stored alias on such a tier is ignored and a new
 * one refused; a tier no model names (Codex) keeps the operator's alias,
 * and promoting there switches the model on.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import {
  clearTierAlias,
  derivedTierDrift,
  listTierAliases,
  loadResolvedTiers,
  setTierAlias
} from '../../src/services/tier-alias-service'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

describe.skipIf(!HAS_DB)('tier-alias-service', () => {
  beforeEach(async () => {
    await resetDbTables()
  })

  afterAll(teardownPrisma)

  const provider = (name: string, apiBaseUrl: string) =>
    getPrismaClient().provider.create({ data: { name, apiBaseUrl, authMode: 'subscription' } })
  const claudeCode = () => provider('claude-code', 'https://api.anthropic.com/v1/messages')
  const codex = () => provider('codex', 'https://chatgpt.com/backend-api/codex')

  const model = (providerId: string, name: string, enabled: boolean) =>
    getPrismaClient().model.create({ data: { providerId, name, enabled } })

  const tierOf = async (provider: string, tier: string) =>
    (await listTierAliases()).find((a) => a.provider === provider && a.tier === tier)

  test('a named tier follows the newest switched-on model; a newer one that is off is a new candidate', async () => {
    const p = await claudeCode()
    await model(p.id, 'claude-sonnet-4-6', true)
    await model(p.id, 'claude-sonnet-5', true)
    await model(p.id, 'claude-sonnet-5-5', false)

    expect(await tierOf('claude-code', 'sonnet')).toEqual({
      provider: 'claude-code',
      tier: 'sonnet',
      mode: 'derived',
      model: 'claude-sonnet-5',
      modelEnabled: true,
      updatedAt: null,
      candidates: [
        { model: 'claude-sonnet-5-5', enabled: false, isNew: true },
        { model: 'claude-sonnet-4-6', enabled: true, isNew: false }
      ]
    })
  })

  test('switching the newer model on moves the tier, with no alias written', async () => {
    const p = await claudeCode()
    await model(p.id, 'claude-sonnet-5', true)
    const newer = await model(p.id, 'claude-sonnet-5-5', false)
    await getPrismaClient().model.update({ where: { id: newer.id }, data: { enabled: true } })

    const resolved = await loadResolvedTiers()
    expect(resolved.get('claude-code|sonnet')?.resolution.model?.name).toBe('claude-sonnet-5-5')
    expect(await getPrismaClient().providerTierAlias.count()).toBe(0)
  })

  test('with every named model off, the tier resolves to the newest one, switched off', async () => {
    const p = await claudeCode()
    await model(p.id, 'claude-opus-4-8', false)
    await model(p.id, 'claude-opus-5', false)
    expect(await tierOf('claude-code', 'opus')).toMatchObject({
      mode: 'derived',
      model: 'claude-opus-5',
      modelEnabled: false
    })
  })

  test('every tier is listed for every provider; one nothing names is manual and unset', async () => {
    await claudeCode()
    const rows = await listTierAliases()
    expect(rows.map((r) => r.tier)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(rows.every((r) => r.mode === 'manual' && r.model === null && r.updatedAt === null)).toBe(true)
  })

  test('an alias on a named tier is refused, and a stored one is ignored', async () => {
    const p = await claudeCode()
    const old = await model(p.id, 'claude-sonnet-4-6', true)
    await model(p.id, 'claude-sonnet-5', true)
    expect(await setTierAlias('claude-code', 'sonnet', 'claude-sonnet-4-6')).toEqual({
      ok: false,
      reason: 'tier-derived'
    })
    // What an older build left behind.
    await getPrismaClient().providerTierAlias.create({ data: { providerId: p.id, tier: 'sonnet', modelId: old.id } })
    expect((await tierOf('claude-code', 'sonnet'))?.model).toBe('claude-sonnet-5')
    expect(await derivedTierDrift()).toEqual([
      'claude-code · sonnet follows claude-sonnet-5; its stored alias named claude-sonnet-4-6'
    ])
  })

  test('Codex names no Claude family, so its tiers keep the operator alias', async () => {
    const p = await codex()
    await model(p.id, 'gpt-5.5', true)
    await model(p.id, 'gpt-5.4', true)
    expect(await setTierAlias('codex', 'sonnet', 'gpt-5.4')).toEqual({ ok: true, enabledModel: false })
    const sonnet = await tierOf('codex', 'sonnet')
    expect(sonnet).toMatchObject({ mode: 'manual', model: 'gpt-5.4', modelEnabled: true, candidates: [] })
    expect(sonnet?.updatedAt).not.toBeNull()
    expect(await derivedTierDrift()).toEqual([])
  })

  test('promoting a model that is off on a manual tier switches it on', async () => {
    const p = await codex()
    await model(p.id, 'gpt-5.5', false)
    expect(await setTierAlias('codex', 'opus', 'gpt-5.5')).toEqual({ ok: true, enabledModel: true })
    const row = await getPrismaClient().model.findFirst({ where: { name: 'gpt-5.5' } })
    expect(row?.enabled).toBe(true)
  })

  test('an unknown provider or model is refused', async () => {
    const p = await codex()
    await model(p.id, 'gpt-5.5', true)
    expect(await setTierAlias('nope', 'opus', 'gpt-5.5')).toEqual({ ok: false, reason: 'provider-not-found' })
    expect(await setTierAlias('codex', 'opus', 'gpt-9')).toEqual({ ok: false, reason: 'model-not-found' })
  })

  test('clearing unsets the alias and reports whether there was one', async () => {
    const p = await codex()
    await model(p.id, 'gpt-5.5', true)
    await setTierAlias('codex', 'haiku', 'gpt-5.5')
    expect(await clearTierAlias('codex', 'haiku')).toBe(true)
    expect(await clearTierAlias('codex', 'haiku')).toBe(false)
  })
})
