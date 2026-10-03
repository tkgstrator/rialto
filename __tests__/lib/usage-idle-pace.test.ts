import { describe, expect, test } from 'bun:test'
import { type ClaudeUsageWire, providerWindows } from '../../src/components/rialto/activity/usage-windows'
import dayjs from '../../src/lib/dayjs'

const idle = (over: Partial<ClaudeUsageWire> = {}): ClaudeUsageWire => ({
  subAccountId: 'idle',
  accountLabel: 'idle',
  fiveHour: { utilization: 0, resetsAt: null },
  sevenDay: null,
  sevenDaySonnet: null,
  sevenDayOpus: null,
  weeklyScoped: [],
  extraUsageEnabled: false,
  capturedAt: dayjs().toISOString(),
  ...over
})

const windowsOf = (account: ClaudeUsageWire) =>
  providerWindows({ claude: [account], codex: [] }, [], (key) => key)[0].accounts[0].windows

describe('idle window pace', () => {
  test('a fresh measured zero without a reset has zero pace', () => {
    expect(windowsOf(idle())[0].projectedPct).toBe(0)
  })

  test('stale zero and nonzero without a reset remain unknown', () => {
    expect(windowsOf(idle({ capturedAt: dayjs().subtract(16, 'minute').toISOString() }))[0].projectedPct).toBeNull()
    expect(windowsOf(idle({ fiveHour: { utilization: 30, resetsAt: null } }))[0].projectedPct).toBeNull()
  })

  test('an unreported window is not turned into a measured zero', () => {
    expect(windowsOf(idle({ fiveHour: null }))).toEqual([])
  })
})
