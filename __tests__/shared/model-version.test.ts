/**
 * The release order read from a model id.
 *
 * A tier routes to the newest switched-on model its name says, so this
 * order is what decides where "claude-code · sonnet" goes once two Sonnets
 * are on. The cases are the id shapes vendors actually publish.
 */
import { describe, expect, test } from 'bun:test'
import { newestFirst, parseModelVersion } from '../../src/shared/model-version'

describe('parseModelVersion', () => {
  test.each([
    ['claude-sonnet-5-5', [5, 5], null],
    ['claude-sonnet-5', [5], null],
    ['claude-sonnet-4-6', [4, 6], null],
    ['claude-sonnet-4-20250514', [4], 20250514],
    ['claude-3-5-sonnet-20241022', [3, 5], 20241022],
    ['claude-haiku-4-5-20251001', [4, 5], 20251001],
    ['claude-sonnet-4-5[1m]', [4, 5], null],
    ['anthropic/claude-sonnet-4.5', [4, 5], null],
    ['us.anthropic.claude-sonnet-4-20250514-v1:0', [4], 20250514],
    ['gpt-5.4-mini', [5, 4], null],
    ['gpt-4-0613', [4], null],
    ['claude-sonnet-latest', [], null]
  ] as const)('%s', (name, parts, date) => {
    expect(parseModelVersion(name)).toEqual({ parts: [...parts], date })
  })
})

describe('newestFirst', () => {
  const sorted = (names: string[]): string[] => [...names].sort(newestFirst)

  test('a higher version wins', () => {
    expect(sorted(['claude-sonnet-4-6', 'claude-sonnet-5-5', 'claude-sonnet-5'])).toEqual([
      'claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-sonnet-4-6'
    ])
  })

  test('a date never outranks a higher version', () => {
    expect(sorted(['claude-sonnet-4-20250514', 'claude-sonnet-4-6'])).toEqual([
      'claude-sonnet-4-6',
      'claude-sonnet-4-20250514'
    ])
    expect(sorted(['claude-3-5-sonnet-20241022', 'claude-sonnet-4-6'])).toEqual([
      'claude-sonnet-4-6',
      'claude-3-5-sonnet-20241022'
    ])
  })

  test('at one version the undated id comes first, then the later snapshot', () => {
    expect(sorted(['claude-haiku-4-5-20251001', 'claude-haiku-4-5'])).toEqual([
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001'
    ])
    expect(sorted(['claude-opus-4-1-20250101', 'claude-opus-4-1-20250805'])).toEqual([
      'claude-opus-4-1-20250805',
      'claude-opus-4-1-20250101'
    ])
  })

  test('an id with no version ranks last', () => {
    expect(sorted(['claude-sonnet-latest', 'claude-sonnet-4-6'])).toEqual(['claude-sonnet-4-6', 'claude-sonnet-latest'])
  })

  test('ties fall to the name, so the order is total', () => {
    expect(sorted(['claude-opus-4-0', 'claude-opus-4'])).toEqual(['claude-opus-4', 'claude-opus-4-0'])
    const names = [
      'claude-sonnet-5-5',
      'claude-sonnet-4-20250514',
      'claude-sonnet-4',
      'claude-sonnet-4-0',
      'claude-3-5-sonnet-20241022',
      'claude-sonnet-latest'
    ]
    const expected = sorted(names)
    expect(sorted([...names].reverse())).toEqual(expected)
    expect(sorted([names[3], names[0], names[5], names[1], names[4], names[2]])).toEqual(expected)
  })
})
