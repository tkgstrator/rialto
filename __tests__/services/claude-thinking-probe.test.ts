import { describe, expect, test } from 'bun:test'
import { probeThinkingOff } from '../../src/services/claude-thinking-probe'

type Sent = { model: string; thinking?: { type: string }; output_config?: { effort: string } }

const ALL = ['low', 'medium', 'high', 'xhigh', 'max'] as const

// How count_tokens answered on 2026-09-29. Sonnet 5.5 refuses `disabled`
// at every effort and takes `between_tools` only at high or below; Sonnet
// 5 takes `disabled` everywhere and has never heard of `between_tools`.
const sonnet55 = (sent: Sent): number => {
  if (sent.thinking?.type === 'disabled') return 400
  if (sent.thinking?.type === 'between_tools') {
    return sent.output_config?.effort === 'xhigh' || sent.output_config?.effort === 'max' ? 400 : 200
  }
  return 200
}
const sonnet5 = (sent: Sent): number => (sent.thinking?.type === 'between_tools' ? 400 : 200)

const upstream =
  (status: (sent: Sent) => number, seen: { url: string; headers: Headers; body: Sent }[] = []): typeof fetch =>
  async (url, init) => {
    const body: Sent = JSON.parse(String(init?.body))
    seen.push({ url: String(url), headers: new Headers(init?.headers), body })
    return new Response('{}', { status: status(body) })
  }

describe('probeThinkingOff', () => {
  test('records which way of switching thinking off each effort takes, with no effort as its own case', async () => {
    expect(await probeThinkingOff('claude-sonnet-5-5', ALL, 'token', upstream(sonnet55))).toEqual({
      disabled: [],
      betweenTools: ['default', 'low', 'medium', 'high']
    })
    expect(await probeThinkingOff('claude-sonnet-5', ALL, 'token', upstream(sonnet5))).toEqual({
      disabled: ['default', ...ALL],
      betweenTools: []
    })
  })

  test('a model that takes no effort is asked only without one', async () => {
    const seen: { url: string; headers: Headers; body: Sent }[] = []
    await probeThinkingOff('claude-haiku-4-5', [], 'token', upstream(sonnet5, seen))
    expect(seen.every((s) => s.body.output_config === undefined)).toBe(true)
  })

  test('asks count_tokens, which runs no inference, as the OAuth bearer', async () => {
    const seen: { url: string; headers: Headers; body: Sent }[] = []
    await probeThinkingOff('claude-sonnet-5-5', ['high'], 'oauth-token', upstream(sonnet55, seen))
    expect(new Set(seen.map((s) => s.url))).toEqual(new Set(['https://api.anthropic.com/v1/messages/count_tokens']))
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer oauth-token')
    expect(seen[0]?.headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
  })

  test('an answer that is not a verdict leaves the model unrecorded', async () => {
    const rateLimited = (sent: Sent) => (sent.output_config?.effort === 'medium' ? 429 : sonnet55(sent))
    expect(await probeThinkingOff('claude-sonnet-5-5', ALL, 'token', upstream(rateLimited))).toBeNull()
    const offline: typeof fetch = async () => {
      throw new Error('offline')
    }
    expect(await probeThinkingOff('claude-sonnet-5-5', ALL, 'token', offline)).toBeNull()
  })

  test('a refused bare request means the probe itself is broken, not that nothing is accepted', async () => {
    expect(
      await probeThinkingOff(
        'claude-unknown',
        ALL,
        'token',
        upstream(() => 400)
      )
    ).toBeNull()
  })
})
