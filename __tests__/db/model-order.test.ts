/**
 * That `Provider.models` comes back in a stable order.
 *
 * The Providers screen's model table renders that array in the order it
 * arrives, and the array comes from a Prisma relation that carried **no
 * `orderBy`**. Without one Postgres may return the rows in any order, so
 * the UPDATE behind a single model toggle moved a row's physical position
 * and the table reordered itself the moment the operator touched it.
 *
 * `subscriptionAccounts` in the same `include` had an `orderBy` from the
 * start — the trace of someone noticing this once and fixing only one half.
 *
 * What is pinned here is not *which* order, but that the same input always
 * produces the same one.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import { applyUiConfig, composeUiConfig, ensurePreferenceProfile } from '../../src/services/config'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

const MODELS = ['gpt-5', 'gpt-5-mini', 'gpt-4o', 'o3', 'gpt-5-nano']

const seed = (enabledOff: string[] = []): Parameters<typeof applyUiConfig>[0] => ({
  Providers: [
    {
      name: 'openai',
      api_base_url: 'https://api.openai.com/v1',
      api_key: 'sk-x',
      auth_mode: 'api_key',
      models: MODELS,
      ...(enabledOff.length > 0 ? { transformer: { _disabledModels: enabledOff } } : {})
    }
  ]
})

const modelOrder = async (): Promise<string[]> => {
  const ui = await composeUiConfig()
  const p = ui.Providers.find((x) => x.name === 'openai')
  if (p === undefined) throw new Error('openai provider missing')
  return p.models
}

describe.skipIf(!HAS_DB)('Provider.models ordering', () => {
  beforeEach(async () => {
    await resetDbTables()
    await ensurePreferenceProfile()
    await applyUiConfig(seed())
  })

  afterAll(async () => {
    await teardownPrisma()
  })

  test('repeated reads return the same order', async () => {
    const first = await modelOrder()
    expect(await modelOrder()).toEqual(first)
    expect(await modelOrder()).toEqual(first)
  })

  test('disabling one model leaves the order alone — this is the symptom itself', async () => {
    const before = await modelOrder()
    // One toggle's worth. The UPDATE may move the row; the displayed
    // order must not move with it.
    await applyUiConfig(seed(['gpt-4o']))
    expect(await modelOrder()).toEqual(before)
  })

  test('repeated toggling leaves the order alone', async () => {
    const before = await modelOrder()
    await applyUiConfig(seed(['gpt-4o']))
    await applyUiConfig(seed(['gpt-4o', 'o3']))
    await applyUiConfig(seed([]))
    expect(await modelOrder()).toEqual(before)
  })

  test('every declared model is present', async () => {
    // So that pinning the order does not quietly hide a dropped row.
    expect((await modelOrder()).slice().sort()).toEqual(MODELS.slice().sort())
  })
})
