import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Browser, Page } from 'playwright'
import type { Provider, SubAccountWire } from '../../src/components/rialto/providers/types'
import { E2E_BASE_URL, HAS_E2E, launchBrowser } from './helpers'

const NAME = 'e2e-subscription'
const account = (id: string, enabled: boolean): SubAccountWire => ({
  id,
  enabled,
  label: id,
  sourcePath: `oauth:claude:${id}`,
  userName: null,
  userEmail: `${id}@example.com`,
  userId: id,
  plan: 'claude_max',
  rateLimitTier: 'default_claude_max_20x',
  monthlyPriceUsd: null,
  expiresAt: null,
  subscriptionEndsAt: null,
  authStatus: 'live',
  authCheckedAt: null,
  authError: null,
  scopes: []
})
const loadedProvider = (): Provider => ({
  name: NAME,
  enabled: true,
  auth_mode: 'subscription',
  api_base_url: 'https://api.anthropic.com',
  api_key: null,
  models: ['claude-sonnet-5'],
  subscription_accounts: [
    { id: 'first', enabled: true },
    { id: 'spare', enabled: false }
  ]
})

// Every write is intercepted. These tests must never disable a real seat.
describe.skipIf(!HAS_E2E)('subscription account switches', () => {
  const held: { browser: Browser | null; page: Page | null } = { browser: null, page: null }
  const state: { provider: Provider; accounts: SubAccountWire[]; writes: Provider[]; fail: boolean } = {
    provider: loadedProvider(),
    accounts: [account('first', true), account('spare', false)],
    writes: [],
    fail: false
  }
  const applyUpdate = (update: Provider) => {
    for (const flip of update.subscription_accounts === undefined ? [] : update.subscription_accounts) {
      state.accounts = state.accounts.map((a) => (a.id === flip.id ? { ...a, enabled: flip.enabled } : a))
    }
    state.provider = {
      ...update,
      subscription_accounts: state.accounts.map((a) => ({ id: a.id, enabled: a.enabled }))
    }
  }
  const page = () => {
    if (held.page === null) throw new Error('page not started')
    return held.page
  }
  const firstSwitch = () => page().getByRole('button', { name: 'Use first@example.com for routing', exact: true })
  const spareSwitch = () => page().getByRole('button', { name: 'Use spare@example.com for routing', exact: true })

  beforeAll(async () => {
    held.browser = await launchBrowser()
  })
  afterAll(async () => {
    if (held.browser !== null) await held.browser.close()
  })
  beforeEach(async () => {
    if (held.browser === null) throw new Error('browser not started')
    state.provider = loadedProvider()
    state.accounts = [account('first', true), account('spare', false)]
    state.writes = []
    state.fail = false
    const context = await held.browser.newContext({ viewport: { width: 1440, height: 900 } })
    held.page = await context.newPage()
    await page().goto(`${E2E_BASE_URL}/setup`, { waitUntil: 'networkidle' })
    await page().route('**/api/providers', async (route) => {
      const request = route.request()
      if (request.method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([state.provider]) })
        return
      }
      const body = request.postData()
      if (body === null) throw new Error('provider write has no body')
      const update: Provider = JSON.parse(body)
      state.writes.push(update)
      if (state.fail) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"save failed"}' })
        return
      }
      applyUpdate(update)
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })
    await page().route('**/api/subscriptions', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          subscriptions: [{ providerName: NAME, kind: 'claude', enabled: true, accounts: state.accounts }]
        })
      })
    })
    for (const [endpoint, response] of [
      ['catalog', '{"entries":[]}'],
      ['transformers', '{"transformers":[]}'],
      ['tier-aliases', '[]']
    ]) {
      await page().route(`**/api/${endpoint}`, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: response })
      })
    }
    await page().route('**/api/overview?*', async (route) => {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
    })
    await page().goto(`${E2E_BASE_URL}/providers/${NAME}`, { waitUntil: 'networkidle' })
    await firstSwitch().waitFor({ state: 'visible' })
  })
  afterEach(async () => {
    if (held.page !== null) await held.page.context().close()
    held.page = null
  })

  test('read-only until Edit, staged until Save, with Revert and no-op restoration', async () => {
    expect(await firstSwitch().isDisabled()).toBe(true)
    expect(await firstSwitch().getAttribute('aria-pressed')).toBe('true')
    expect(await spareSwitch().getAttribute('aria-pressed')).toBe('false')
    await page().getByRole('button', { name: 'Edit', exact: true }).click()
    await firstSwitch().click()
    expect(await firstSwitch().getAttribute('aria-pressed')).toBe('false')
    expect(state.writes).toHaveLength(0)
    expect(await page().getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(false)
    await firstSwitch().click()
    expect(await page().getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
    await firstSwitch().click()
    await page().getByRole('button', { name: 'Revert', exact: true }).click()
    expect(await firstSwitch().getAttribute('aria-pressed')).toBe('true')
    expect(await firstSwitch().isDisabled()).toBe(true)
    expect(state.writes).toHaveLength(0)
  })

  test('saves the last enabled seat off, reloads, and can re-enable a disabled seat', async () => {
    await page().getByRole('button', { name: 'Edit', exact: true }).click()
    await firstSwitch().click()
    await page().getByRole('button', { name: 'Save', exact: true }).click()
    await page().getByRole('button', { name: 'Edit', exact: true }).waitFor({ state: 'visible' })
    expect(state.writes).toHaveLength(1)
    expect(state.writes[0].subscription_accounts).toEqual([{ id: 'first', enabled: false }])
    expect(await firstSwitch().getAttribute('aria-pressed')).toBe('false')
    await page().getByRole('button', { name: 'Edit', exact: true }).click()
    await spareSwitch().click()
    await page().getByRole('button', { name: 'Save', exact: true }).click()
    await page().getByRole('button', { name: 'Edit', exact: true }).waitFor({ state: 'visible' })
    expect(state.writes[1].subscription_accounts).toEqual([{ id: 'spare', enabled: true }])
    expect(await spareSwitch().getAttribute('aria-pressed')).toBe('true')
    await page().setViewportSize({ width: 390, height: 844 })
    await page().getByRole('button', { name: 'Edit', exact: true }).waitFor({ state: 'hidden' })
    expect(await spareSwitch().isDisabled()).toBe(true)
    expect(await spareSwitch().isVisible()).toBe(true)
    expect(await page().getByRole('button', { name: 'Edit', exact: true }).count()).toBe(0)
    const overflow = await page().evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    expect(overflow).toBe(0)
  })

  test('a failed save shows the error and reloads the stored switch values', async () => {
    state.fail = true
    await page().getByRole('button', { name: 'Edit', exact: true }).click()
    await firstSwitch().click()
    await page().getByRole('button', { name: 'Save', exact: true }).click()
    await page().getByRole('button', { name: 'Edit', exact: true }).waitFor({ state: 'visible' })
    expect(await firstSwitch().getAttribute('aria-pressed')).toBe('true')
    expect(await page().getByText('save failed', { exact: false }).isVisible()).toBe(true)
    expect(state.writes).toHaveLength(1)
  })
})
