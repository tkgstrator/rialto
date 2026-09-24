/**
 * Scheduler ticks never overlap.
 *
 * Two overlapping ticks could publish out of order and put a reading the
 * other had already replaced back in front of the router. The timer shares
 * a tick already in flight; a republish after fresh quota has been written
 * waits for it and runs one more, because joining it would publish the
 * reading from before the write.
 *
 * DB-gated: a tick reads the subscription providers and SubAccountQuota.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { republishRoutingSnapshot, runSchedulerTick } from '../../../src/services/routing-scheduler'
import { __resetSchedulerStateForTest } from '../../../src/services/routing-scheduler/state'
import { HAS_DB, resetDbTables, teardownPrisma } from '../../db/helpers'

describe.skipIf(!HAS_DB)('scheduler tick concurrency', () => {
  beforeEach(async () => {
    await resetDbTables()
    __resetSchedulerStateForTest()
  })

  afterAll(async () => {
    await teardownPrisma()
  })

  test('two ticks asked for at once are one tick', async () => {
    const first = runSchedulerTick()
    const second = runSchedulerTick()
    expect(second).toBe(first)
    const [a, b] = await Promise.all([first, second])
    expect(a).not.toBeNull()
    expect(b).toBe(a)
  })

  test('a republish during a running tick runs exactly one more tick after it', async () => {
    const running = runSchedulerTick()
    const republished = republishRoutingSnapshot()
    const alsoRepublished = republishRoutingSnapshot()
    expect(alsoRepublished).toBe(republished)
    const [before, after] = await Promise.all([running, republished])
    if (before === null || after === null) throw new Error('a tick failed')
    expect(after.tickCount).toBe(before.tickCount + 1)
  })

  test('a republish with nothing running starts a tick of its own', async () => {
    const snapshot = await republishRoutingSnapshot()
    expect(snapshot).not.toBeNull()
  })
})
