/**
 * Which targets a tick publishes quota for.
 *
 * It used to be the `live` profile's chain only, which left every other
 * profile's routes unguarded on quota. A tier route can name any
 * provider's alias, so the snapshot covers every enabled model of every
 * enabled subscription provider — and nothing an api_key provider serves,
 * which has no quota the scheduler knows about.
 *
 * DB-gated: a tick reads Provider / Model / SubAccountQuota.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../../src/db/client'
import dayjs from '../../../src/lib/dayjs'
import { runSchedulerTick } from '../../../src/services/routing-scheduler'
import { __resetSchedulerStateForTest } from '../../../src/services/routing-scheduler/state'
import { HAS_DB, resetDbTables, teardownPrisma } from '../../db/helpers'

describe.skipIf(!HAS_DB)('scheduler tick targets', () => {
  beforeEach(async () => {
    await resetDbTables()
    __resetSchedulerStateForTest()
  })

  afterAll(async () => {
    await teardownPrisma()
  })

  test('every enabled model of every enabled subscription provider, and nothing else', async () => {
    const prisma = getPrismaClient()
    const claude = await prisma.provider.create({
      data: { name: 'claude-code', apiBaseUrl: 'https://api.anthropic.com/v1/messages', authMode: 'subscription' }
    })
    const parked = await prisma.provider.create({
      data: { name: 'codex', apiBaseUrl: 'https://chatgpt.com/backend-api', authMode: 'subscription', enabled: false }
    })
    const keyed = await prisma.provider.create({
      data: { name: 'openai', apiBaseUrl: 'https://api.openai.com/v1', authMode: 'api_key' }
    })
    await prisma.model.createMany({
      data: [
        { providerId: claude.id, name: 'claude-sonnet-5', enabled: true },
        { providerId: claude.id, name: 'claude-haiku-4-5', enabled: false },
        { providerId: parked.id, name: 'gpt-5.5', enabled: true },
        { providerId: keyed.id, name: 'gpt-5', enabled: true }
      ]
    })

    const snapshot = await runSchedulerTick()
    expect(snapshot === null ? null : [...snapshot.targets.keys()]).toEqual(['claude-code,claude-sonnet-5'])
  })

  test("an account's spent weekly window holds the target until it resets", async () => {
    const prisma = getPrismaClient()
    const claude = await prisma.provider.create({
      data: { name: 'claude-code', apiBaseUrl: 'https://api.anthropic.com/v1/messages', authMode: 'subscription' }
    })
    await prisma.model.create({ data: { providerId: claude.id, name: 'claude-sonnet-5', enabled: true } })
    const acct = await prisma.subAccount.create({
      data: { providerId: claude.id, sourcePath: 'oauth:test:spent', label: 'spent' }
    })
    const resetAt = dayjs().add(2, 'day').startOf('second')
    await prisma.subAccountQuota.create({
      data: {
        subAccountId: acct.id,
        weeklyUsed: 100,
        weeklyLimit: 100,
        weeklyResetAt: resetAt.toDate(),
        quotaRefreshedAt: dayjs().toDate()
      }
    })

    const snapshot = await runSchedulerTick()
    const target = snapshot === null ? undefined : snapshot.targets.get('claude-code,claude-sonnet-5')
    expect(target?.exhausted).toBe(true)
    expect(target?.resetAt).toBe(resetAt.valueOf())
    expect(snapshot?.soonestResetAt).toBe(resetAt.valueOf())
  })
})
