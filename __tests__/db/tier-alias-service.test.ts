/**
 * Provider tier aliases.
 *
 * Pinned: an alias only moves when someone moves it — a model that shows
 * up later is a candidate marked new, not a replacement; promoting a model
 * switches it on; a subscription preset seeds the aliases its models imply
 * without touching one already set; and a provider whose models name no
 * Claude family (Codex) gets none.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import dayjs from '../../src/lib/dayjs'
import {
  clearTierAlias,
  ensurePresetAliases,
  listTierAliases,
  resolveTierAliases,
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

  const model = (providerId: string, name: string, enabled: boolean, createdAt = dayjs().subtract(1, 'day').toDate()) =>
    getPrismaClient().model.create({ data: { providerId, name, enabled, createdAt } })

  test('a model that appears after the alias was set is a new candidate, not a replacement', async () => {
    const p = await provider('claude-code', 'https://api.anthropic.com/v1/messages')
    await model(p.id, 'claude-sonnet-5', true)
    await model(p.id, 'claude-sonnet-4-6', true)
    expect(await setTierAlias('claude-code', 'sonnet', 'claude-sonnet-5')).toEqual({ ok: true, enabledModel: false })
    await model(p.id, 'claude-sonnet-5-1', false, dayjs().add(1, 'minute').toDate())

    const sonnet = (await listTierAliases()).find((a) => a.provider === 'claude-code' && a.tier === 'sonnet')
    expect(sonnet?.model).toBe('claude-sonnet-5')
    expect(sonnet?.candidates).toEqual([
      { model: 'claude-sonnet-5-1', enabled: false, isNew: true },
      { model: 'claude-sonnet-4-6', enabled: true, isNew: false }
    ])
  })

  test('every tier is listed for every provider, set or not', async () => {
    await provider('claude-code', 'https://api.anthropic.com/v1/messages')
    const rows = await listTierAliases()
    expect(rows.map((r) => r.tier)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(rows.every((r) => r.model === null && r.updatedAt === null)).toBe(true)
  })

  test('promoting a model that is off switches it on', async () => {
    const p = await provider('claude-code', 'https://api.anthropic.com/v1/messages')
    await model(p.id, 'claude-opus-5', false)
    expect(await setTierAlias('claude-code', 'opus', 'claude-opus-5')).toEqual({ ok: true, enabledModel: true })
    const row = await getPrismaClient().model.findFirst({ where: { name: 'claude-opus-5' } })
    expect(row?.enabled).toBe(true)
  })

  test('an unknown provider or model is refused', async () => {
    const p = await provider('claude-code', 'https://api.anthropic.com/v1/messages')
    await model(p.id, 'claude-opus-5', true)
    expect(await setTierAlias('nope', 'opus', 'claude-opus-5')).toEqual({ ok: false, reason: 'provider-not-found' })
    expect(await setTierAlias('claude-code', 'opus', 'claude-opus-9')).toEqual({ ok: false, reason: 'model-not-found' })
  })

  test('clearing unsets the alias and reports whether there was one', async () => {
    const p = await provider('claude-code', 'https://api.anthropic.com/v1/messages')
    await model(p.id, 'claude-haiku-4-5', true)
    await setTierAlias('claude-code', 'haiku', 'claude-haiku-4-5')
    expect(await clearTierAlias('claude-code', 'haiku')).toBe(true)
    expect(await clearTierAlias('claude-code', 'haiku')).toBe(false)
  })

  test('a Claude subscription gets the aliases its preset implies, the first listed model per tier', async () => {
    const p = await provider('claude-code', 'https://api.anthropic.com/v1/messages')
    for (const name of [
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-5',
      'claude-haiku-4-5'
    ]) {
      await model(p.id, name, true)
    }
    const created = await getPrismaClient().$transaction((tx) => ensurePresetAliases(tx, p.id))
    expect(created).toBe(4)
    const resolved = await resolveTierAliases()
    expect(resolved.get('claude-code|opus')?.model).toBe('claude-opus-4-8')
    expect(resolved.get('claude-code|sonnet')).toEqual({
      provider: 'claude-code',
      tier: 'sonnet',
      model: 'claude-sonnet-5',
      modelEnabled: true,
      providerEnabled: true
    })
  })

  test('an alias already set survives the preset', async () => {
    const p = await provider('claude-code', 'https://api.anthropic.com/v1/messages')
    await model(p.id, 'claude-sonnet-5', true)
    await model(p.id, 'claude-sonnet-4-6', true)
    await setTierAlias('claude-code', 'sonnet', 'claude-sonnet-4-6')
    await getPrismaClient().$transaction((tx) => ensurePresetAliases(tx, p.id))
    expect((await resolveTierAliases()).get('claude-code|sonnet')?.model).toBe('claude-sonnet-4-6')
  })

  test('Codex names no Claude family, so its aliases are left to the operator', async () => {
    const p = await provider('codex', 'https://chatgpt.com/backend-api/codex')
    await model(p.id, 'gpt-5.5', true)
    expect(await getPrismaClient().$transaction((tx) => ensurePresetAliases(tx, p.id))).toBe(0)
  })
})
