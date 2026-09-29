/**
 * The readings beside a model's name on a wide provider page.
 *
 * The thinking-off shapes below are the ones the probe records on the
 * current Claude line-up (docs/architecture/model-capabilities.md). The
 * reading has to say which setting holds and up to which effort, since
 * that is what a caller's `thinking: disabled` is fitted to.
 */
import { describe, expect, test } from 'bun:test'
import { effortLadder, thinkingOffReadings } from '../../../src/components/rialto/providers/capability-reading'

const CLAUDE = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const WITH_DEFAULT = ['default', ...CLAUDE] as const

describe('effortLadder', () => {
  test('orders the recorded levels lowest first, whatever order they were listed in', () => {
    expect(effortLadder(['max', 'low', 'high'])).toEqual(['low', 'high', 'max'])
  })

  test('keeps Codex ultra above xhigh', () => {
    expect(effortLadder(['ultra', 'xhigh', 'low'])).toEqual(['low', 'xhigh', 'ultra'])
  })

  test('drops the local auto policy, which no model reports', () => {
    expect(effortLadder(['auto', 'medium'])).toEqual(['medium'])
  })
})

describe('thinkingOffReadings', () => {
  test('Sonnet 5: disabled at every effort', () => {
    expect(thinkingOffReadings({ disabled: [...WITH_DEFAULT], betweenTools: [] }, CLAUDE)).toEqual([
      { setting: 'disabled', when: 'always' }
    ])
  })

  test('Sonnet 5.5: between_tools up to high', () => {
    expect(thinkingOffReadings({ disabled: [], betweenTools: ['default', 'low', 'medium', 'high'] }, CLAUDE)).toEqual([
      { setting: 'between_tools', when: 'upTo', effort: 'high' }
    ])
  })

  test('Opus 5: disabled up to high, whether or not the no-effort probe held', () => {
    expect(thinkingOffReadings({ disabled: ['low', 'medium', 'high'], betweenTools: [] }, CLAUDE)).toEqual([
      { setting: 'disabled', when: 'upTo', effort: 'high' }
    ])
  })

  test('Opus 5.5 and Fable: nothing, so thinking cannot be switched off', () => {
    expect(thinkingOffReadings({ disabled: [], betweenTools: [] }, CLAUDE)).toEqual([])
  })

  test('a model with no effort levels reads its one probe as always', () => {
    expect(thinkingOffReadings({ disabled: ['default'], betweenTools: [] }, [])).toEqual([
      { setting: 'disabled', when: 'always' }
    ])
  })

  test('a set with a gap is listed rather than summarised', () => {
    expect(thinkingOffReadings({ disabled: ['default', 'low', 'high'], betweenTools: [] }, CLAUDE)).toEqual([
      { setting: 'disabled', when: 'at', keys: ['default', 'low', 'high'] }
    ])
  })

  test('lists disabled before between_tools, the order the pipeline tries them', () => {
    expect(
      thinkingOffReadings({ disabled: ['low', 'medium'], betweenTools: [...WITH_DEFAULT] }, CLAUDE).map(
        (reading) => reading.setting
      )
    ).toEqual(['disabled', 'between_tools'])
  })
})
