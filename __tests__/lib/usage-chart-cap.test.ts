import { describe, expect, test } from 'bun:test'
import { type ChartPoint, capPacePoints, PACE_CHART_MAX } from '../../src/components/rialto/activity/usage-history'

const series = [
  { metric: 'codex.primary', label: 'Codex' },
  { metric: 'claude.five_hour', label: 'Claude' }
]

describe('capPacePoints', () => {
  test('caps plotted forecasts at 300% without changing the tooltip values', () => {
    const points: ChartPoint[] = [{ t: 1234, 'codex.primary': 1227, 'claude.five_hour': 125 }]
    const plotted = capPacePoints(points, series)
    expect(PACE_CHART_MAX).toBe(300)
    expect(plotted).toEqual([{ t: 1234, 'codex.primary': 300, 'claude.five_hour': 125 }])
    expect(points[0]['codex.primary']).toBe(1227)
    expect(plotted[0]).not.toBe(points[0])
  })

  test('preserves zero, the upper boundary and missing readings', () => {
    expect(
      capPacePoints(
        [
          { t: 1, 'codex.primary': 0, 'claude.five_hour': 300 },
          { t: 2, 'codex.primary': null, 'claude.five_hour': null }
        ],
        series
      )
    ).toEqual([
      { t: 1, 'codex.primary': 0, 'claude.five_hour': 300 },
      { t: 2, 'codex.primary': null, 'claude.five_hour': null }
    ])
  })

  test('an empty chart remains empty', () => {
    expect(capPacePoints([], series)).toEqual([])
  })
})
