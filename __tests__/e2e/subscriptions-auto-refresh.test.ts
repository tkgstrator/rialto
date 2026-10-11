import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Browser, Page, Route } from 'playwright'
import type { Provider, SubAccountWire } from '../../src/components/rialto/providers/types'
import { E2E_BASE_URL, HAS_E2E, launchBrowser } from './helpers'

const NAME = 'e2e-auto-refresh'
const NOW = Date.parse('2026-10-01T12:00:00Z')
const ACCOUNT: SubAccountWire = {
  id: 'auto-seat',
  enabled: true,
  label: 'Auto seat',
  sourcePath: 'oauth:claude:auto-seat',
  userName: null,
  userEmail: 'auto@example.com',
  userId: 'auto-seat',
  plan: 'claude_max',
  rateLimitTier: 'default_claude_max_20x',
  monthlyPriceUsd: null,
  expiresAt: null,
  subscriptionEndsAt: null,
  authStatus: 'live',
  authCheckedAt: null,
  authError: null,
  scopes: []
}

// All provider/usage reads are fixtures, and every mutation is rejected.
// Advancing browser time must never force a real upstream account refresh.
describe.skipIf(!HAS_E2E)('subscription background refresh', () => {
  const held: { browser: Browser | null; page: Page | null; read: Route | null } = {
    browser: null,
    page: null,
    read: null
  }
  const state = {
    reads: 0,
    pct: 25,
    failProviders: false,
    failOptional: false,
    hold: false,
    apiKey: false,
    mutations: new Set<string>()
  }
  const page = () => {
    if (held.page === null) throw new Error('page not started')
    return held.page
  }
  const provider = (): Provider => ({
    name: NAME,
    enabled: true,
    auth_mode: state.apiKey ? 'api_key' : 'subscription',
    api_base_url: 'https://api.anthropic.com',
    api_key: state.apiKey ? 'test-key' : null,
    models: ['claude-sonnet-5'],
    subscription_accounts: [{ id: ACCOUNT.id, enabled: true }]
  })
  const fulfillProviders = (route: Route) =>
    route.fulfill({
      status: state.failProviders ? 503 : 200,
      contentType: 'application/json',
      body: state.failProviders ? '{"error":"temporarily offline"}' : JSON.stringify([provider()])
    })
  const overview = () => ({
    // A deliberately old collection instant: countdown follows the current
    // browser clock, not this stale snapshot timestamp.
    generatedAt: '2026-09-01T12:00:00Z',
    providerCount: 1,
    enabledModelCount: 1,
    quota: [
      {
        subAccountId: ACCOUNT.id,
        resetCredits: null,
        windows: [
          {
            window: '5h',
            scope: null,
            pct: state.pct,
            resetAt: '2026-10-01T12:02:00Z'
          }
        ]
      }
    ]
  })
  const routeRead = async (route: Route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() !== 'GET') {
      state.mutations.add(path)
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":"no live mutation allowed"}'
      })
      return
    }
    if (path === '/api/providers') {
      state.reads++
      if (state.hold) {
        held.read = route
        return
      }
      await fulfillProviders(route)
      return
    }
    if (state.failOptional) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
      return
    }
    const bodies: Record<string, unknown> = {
      '/api/subscriptions': {
        subscriptions: [{ providerName: NAME, kind: 'claude', enabled: true, accounts: [ACCOUNT] }]
      },
      '/api/catalog': { entries: [] },
      '/api/transformers': { transformers: [] },
      '/api/tier-aliases': [],
      '/api/overview': overview()
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bodies[path]) })
  }
  const open = async (path = `/providers/${NAME}`) => {
    await page().goto(`${E2E_BASE_URL}${path}`, { waitUntil: 'networkidle' })
    await page().getByText('25%', { exact: true }).waitFor({ state: 'visible' })
  }
  const tick = async (pct: number) => {
    state.pct = pct
    await page().clock.runFor(30_000)
    await page().getByText(`${pct}%`, { exact: true }).waitFor({ state: 'visible' })
  }

  beforeAll(async () => {
    held.browser = await launchBrowser()
  })
  afterAll(async () => {
    if (held.browser !== null) await held.browser.close()
  })
  beforeEach(async () => {
    if (held.browser === null) throw new Error('browser not started')
    state.reads = 0
    state.pct = 25
    state.failProviders = false
    state.failOptional = false
    state.hold = false
    state.apiKey = false
    state.mutations.clear()
    held.read = null
    held.page = await (await held.browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
    await page().goto(`${E2E_BASE_URL}/setup`, { waitUntil: 'networkidle' })
    await page().clock.install({ time: NOW })
    await page().clock.pauseAt(NOW + 1)
    for (const endpoint of ['providers', 'subscriptions', 'catalog', 'transformers', 'tier-aliases']) {
      await page().route(`**/api/${endpoint}`, routeRead)
    }
    await page().route('**/api/overview?*', routeRead)
    for (const endpoint of ['subscriptions/refresh', 'catalog/refresh', 'refresh-models']) {
      await page().route(`**/api/${endpoint}`, routeRead)
    }
  })
  afterEach(async () => {
    if (held.page !== null) await held.page.context().close()
    held.page = null
    held.read = null
  })

  test('polls stored subscription data silently and advances the countdown', async () => {
    await open()
    const initialReads = state.reads
    expect(await page().getByText('2m', { exact: true }).isVisible()).toBe(true)
    await tick(66)
    expect(state.reads).toBe(initialReads + 1)
    await tick(77)
    expect(await page().getByText('1m', { exact: true }).isVisible()).toBe(true)
    expect(state.mutations.size).toBe(0)
    expect(await page().getByRole('button', { name: 'Edit', exact: true }).isVisible()).toBe(true)
  })

  test('an edit pauses reads while its countdown and staged account switch survive', async () => {
    await open()
    const initialReads = state.reads
    await page().getByRole('button', { name: 'Edit', exact: true }).click()
    const toggle = page().getByRole('button', { name: 'Use auto@example.com for routing', exact: true })
    await toggle.click()
    await page().clock.runFor(60_000)
    expect(state.reads).toBe(initialReads)
    expect(await toggle.getAttribute('aria-pressed')).toBe('false')
    expect(await page().getByText('1m', { exact: true }).isVisible()).toBe(true)
    await page().getByRole('button', { name: 'Revert', exact: true }).click()
    await tick(80)
    expect(state.reads).toBe(initialReads + 1)
    expect(await toggle.getAttribute('aria-pressed')).toBe('true')
  })

  test('failed background reads retain successful account and quota values', async () => {
    await open()
    state.failOptional = true
    const optionalFailure = page().waitForResponse('**/api/overview?*')
    await page().clock.runFor(30_000)
    await optionalFailure
    expect(await page().getByText('25%', { exact: true }).isVisible()).toBe(true)
    expect(await page().getByText('auto@example.com', { exact: true }).isVisible()).toBe(true)
    state.failProviders = true
    const providerFailure = page().waitForResponse('**/api/providers')
    await page().clock.runFor(30_000)
    await providerFailure
    expect(await page().getByText('25%', { exact: true }).isVisible()).toBe(true)
    state.failProviders = false
    state.failOptional = false
    await tick(55)
  })

  test('a slow poll does not overlap another poll or overwrite a newly opened edit', async () => {
    await open()
    const initialReads = state.reads
    state.hold = true
    state.pct = 88
    await page().clock.runFor(30_000)
    await page().waitForFunction(() => document.querySelector('main') !== null)
    expect(state.reads).toBe(initialReads + 1)
    await page().clock.runFor(30_000)
    expect(state.reads).toBe(initialReads + 1)
    await page().getByRole('button', { name: 'Edit', exact: true }).click()
    const toggle = page().getByRole('button', { name: 'Use auto@example.com for routing', exact: true })
    await toggle.click()
    if (held.read === null) throw new Error('expected held background read')
    state.hold = false
    await fulfillProviders(held.read)
    await page().clock.runFor(30_000)
    expect(await toggle.getAttribute('aria-pressed')).toBe('false')
    expect(await page().getByText('25%', { exact: true }).isVisible()).toBe(true)
    await page().getByRole('button', { name: 'Revert', exact: true }).click()
    await tick(88)
  }, 20_000)

  test('hidden tabs pause and resume with a fresh read', async () => {
    await open()
    const initialReads = state.reads
    await page().evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page().clock.runFor(90_000)
    expect(state.reads).toBe(initialReads)
    state.pct = 91
    await page().evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page().getByText('91%', { exact: true }).waitFor({ state: 'visible' })
    expect(state.reads).toBe(initialReads + 1)
  })

  test('Subscriptions list polls but API-key screens do not', async () => {
    await open('/providers/subscriptions')
    const initialReads = state.reads
    await tick(64)
    expect(state.reads).toBe(initialReads + 1)
    state.apiKey = true
    await page().goto(`${E2E_BASE_URL}/providers/${NAME}`, { waitUntil: 'networkidle' })
    await page().getByRole('button', { name: 'Edit', exact: true }).waitFor({ state: 'visible' })
    const reads = state.reads
    await page().clock.runFor(90_000)
    expect(state.reads).toBe(reads)
    expect(state.mutations.size).toBe(0)
  })
})
