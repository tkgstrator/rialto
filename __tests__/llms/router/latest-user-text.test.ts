import { describe, expect, test } from 'bun:test'
import { latestUserText } from '../../../src/llms/router/request-signals'

describe('latestUserText', () => {
  test('takes the newest user text and skips reminders and tool results', () => {
    const messages = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'x' },
      {
        role: 'user',
        content: [
          { type: 'tool_result', content: 'ignored' },
          { type: 'text', text: '<system-reminder>noise</system-reminder>' },
          { type: 'text', text: 'リファクタして' }
        ]
      }
    ]
    expect(latestUserText(messages)).toBe('リファクタして')
  })
  test('truncates and tolerates junk', () => {
    expect(latestUserText([{ role: 'user', content: 'a'.repeat(5000) }])?.length).toBe(2000)
    expect(latestUserText(undefined)).toBeUndefined()
  })
})
