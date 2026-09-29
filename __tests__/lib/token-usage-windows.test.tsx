import { describe, expect, test } from 'bun:test'
import { createInstance } from 'i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { TokenUsageWindows } from '../../src/components/rialto/settings/access/TokenUsageWindows'
import type { AccessTokenWire, TokenUsageWindowsWire } from '../../src/lib/api-types'
import { usageWindowsView } from '../../src/lib/rialto/settings/usage-windows'
import en from '../../src/locales/en.json'

const i18n = createInstance()
await i18n.init({
  lng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
  initImmediate: false
})

const NOW = Date.parse('2026-09-29T06:19:00.000Z')

const TOKEN: AccessTokenWire = {
  id: 'tok_1',
  name: 'MacBook — Codex',
  prefix: 'rlt_7c02…',
  surfaces: [],
  profileKey: null,
  lastUsedAt: null,
  requestCount: 0,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  createdAt: '2026-06-04T00:00:00.000Z',
  expiresAt: null,
  revokedAt: null,
  rotatedAt: null,
  plan: { id: 'plan_free', name: 'Free' }
}

const usage = (fiveRequests: number, weekCost: number, started = true): TokenUsageWindowsWire => ({
  limited: true,
  windows: [
    {
      window: '5h',
      startedAt: started ? '2026-09-29T04:00:00.000Z' : null,
      resetsAt: started ? '2026-09-29T09:00:00.000Z' : null,
      requests: started ? fiveRequests : 0,
      requestLimit: 100,
      costUsd: started ? 0.84 : 0,
      spendLimitUsd: null
    },
    {
      window: '7d',
      startedAt: started ? '2026-09-26T00:00:00.000Z' : null,
      resetsAt: started ? '2026-10-03T00:00:00.000Z' : null,
      requests: started ? 286 : 0,
      requestLimit: 500,
      costUsd: started ? weekCost : 0,
      spendLimitUsd: 10
    }
  ]
})

const render = (plan: string | null, wire: TokenUsageWindowsWire | null) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <TokenUsageWindows token={TOKEN} view={usageWindowsView(plan, wire)} now={NOW} onReset={() => {}} />
    </I18nextProvider>
  )

describe('token usage windows', () => {
  test('open windows: meters, figures, No limit, and Reset usage', () => {
    const html = render('Free', usage(42, 5.72))
    expect(html).toContain('5-hour window')
    expect(html).toContain('7-day window')
    expect(html).toContain('42 / 100')
    expect(html).toContain('$0.84 used')
    expect(html).toContain('No limit')
    expect(html).toContain('$5.72 / $10.00')
    expect(html).toContain('Resets in 2h 41m')
    expect(html).toContain('Reset usage')
    expect(html).not.toContain('Requests refused')
  })

  test('a spent window: the pill and the block naming the limit and when it lifts', () => {
    const html = render('Free', usage(42, 10))
    expect(html).toContain('>spent<')
    expect(html).toContain('Requests refused (429) until')
    expect(html).toContain('7-day spend limit reached.')
    expect(html).toContain('Every spent window must reset before requests resume.')
  })

  test('not started: Not started and nothing to reset', () => {
    const html = render('Free', usage(0, 0, false))
    expect(html).toContain('Not started')
    expect(html).toContain('Nothing to reset')
    expect(html).toContain('The next counted request starts each window.')
    expect(html).not.toContain('Reset usage')
  })

  test('no plan and an unlimited plan: the note, no meters, no reset', () => {
    const none = render(null, null)
    expect(none).toContain('No plan usage limits.')
    expect(none).toContain('Assign a plan')
    expect(none).not.toContain('Reset usage')
    const max = render('Max', { limited: false, windows: [] })
    expect(max).toContain('Max has no request or spend limits in either window.')
    expect(max).not.toContain('Reset usage')
  })
})
