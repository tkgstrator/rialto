/**
 * E2E for the two Providers lists.
 *
 * What this guards is the kind of gap left by an empty state nobody
 * designed. The approved mocks only draw these screens populated, so the
 * "no providers yet" case has no picture to diff against and the rule has
 * to be pinned here instead: the empty-state sentence names a button, and
 * that button has to be on the screen it is written on.
 *
 * The screen this file used to test was one master-detail page behind an
 * 18rem rail, and the rule it pinned was about a second "Add provider" at
 * the foot of that rail. The rail is gone — its two groups are sidebar
 * sub-entries now — so there is exactly one add button per list, in the
 * header, and no way for a screen to offer three routes to the same
 * place.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Browser, Page } from 'playwright'
import { E2E_BASE_URL, HAS_E2E, launchBrowser } from './helpers'

const held: { browser: Browser | null } = { browser: null }

const browser = (): Browser => {
  if (held.browser === null) throw new Error('browser not started')
  return held.browser
}

/** Both lists, with the add button each one offers. */
const LISTS = [
  { path: '/providers/subscriptions', add: 'Add subscription', empty: 'No subscriptions connected yet' },
  { path: '/providers/api-keys', add: 'Add key', empty: 'No API-key providers configured yet' }
] as const

/** The first-run gate opens once /setup has rendered. From a bare
 *  context, going to a provider list bounces to /setup, so pass through
 *  it first. */
async function open(path: string): Promise<Page> {
  const context = await browser().newContext()
  const page = await context.newPage()
  await page.goto(`${E2E_BASE_URL}/setup`, { waitUntil: 'networkidle' })
  await page.goto(`${E2E_BASE_URL}${path}`, { waitUntil: 'networkidle' })
  return page
}

/** Rows in the list. Each one is a route into that provider's own page. */
const providerCount = (page: Page): Promise<number> => page.locator('tbody tr').count()

describe.skipIf(!HAS_E2E)('Providers lists', () => {
  beforeAll(async () => {
    held.browser = await launchBrowser()
  })

  afterAll(async () => {
    if (held.browser !== null) await held.browser.close()
  })

  test('/providers lands on Subscriptions rather than rendering a third thing', async () => {
    // The section root redirects: a path that shows one of two peers
    // without saying which is a path the sidebar cannot highlight.
    const page = await open('/providers')
    expect(new URL(page.url()).pathname).toBe('/providers/subscriptions')
    await page.context().close()
  })

  for (const list of LISTS) {
    test(`${list.path} offers exactly one way to add`, async () => {
      const page = await open(list.path)
      expect(await page.getByText(list.add, { exact: true }).count()).toBe(1)
      await page.context().close()
    })

    test(`${list.path} — the empty-state message points at a button that exists`, async () => {
      // Guards against saying "Use Add provider to connect one" while no
      // "Add provider" is on the screen.
      const page = await open(list.path)
      if ((await providerCount(page)) === 0) {
        // bun:test's expect has none of playwright's matchers
        // (toBeVisible), so resolve the boolean on the locator first.
        expect(await page.getByText(list.empty, { exact: false }).isVisible()).toBe(true)
        expect(await page.getByText(list.add, { exact: true }).count()).toBeGreaterThan(0)
      }
      await page.context().close()
    })
  }

  test('Models in the sidebar opens a searchable cross-provider list', async () => {
    const page = await open('/providers/subscriptions')
    await page.getByRole('link', { name: 'Model list', exact: true }).click()
    await page.waitForURL('**/providers/models')
    await page.getByRole('searchbox', { name: 'Filter models' }).waitFor({ state: 'visible' })
    expect(await page.getByRole('searchbox', { name: 'Filter models' }).isVisible()).toBe(true)
    await page.context().close()
  })

  test('model switches and manual tier picks use the provider mutations', async () => {
    const page = await open('/overview')
    const writes: Array<{ method: string; url: string; body: string }> = []
    const provider = {
      name: 'e2e-manual',
      auth_mode: 'api_key',
      api_base_url: 'https://example.com/v1',
      api_key: 'test-key',
      enabled: true,
      models: ['alpha', 'beta'],
      transformer: { _disabledModels: ['alpha'] }
    }
    await page.route('**/api/providers', async (route) => {
      const request = route.request()
      if (request.method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([provider]) })
        return
      }
      const body = request.postData()
      writes.push({ method: request.method(), url: request.url(), body: body === null ? '' : body })
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })
    await page.route('**/api/tier-aliases', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    })
    await page.route('**/api/providers/e2e-manual/tier-aliases/opus', async (route) => {
      const request = route.request()
      const body = request.postData()
      writes.push({ method: request.method(), url: request.url(), body: body === null ? '' : body })
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"enabledModel":true}' })
    })
    await page.goto(`${E2E_BASE_URL}/providers/models`, { waitUntil: 'networkidle' })
    expect(await page.getByRole('button', { name: 'Toggle beta' }).isDisabled()).toBe(true)
    expect(await page.getByRole('combobox', { name: 'Model the opus alias points at' }).count()).toBe(0)
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    expect(await page.getByRole('button', { name: 'Toggle beta' }).isDisabled()).toBe(false)
    await page.getByRole('button', { name: 'Toggle beta' }).click()
    await page.waitForFunction(
      () => document.querySelector<HTMLButtonElement>('button[aria-label="Toggle beta"]')?.disabled === false
    )
    const switchWrite = writes[0]
    if (switchWrite === undefined) throw new Error('model switch did not write')
    expect(switchWrite.method).toBe('POST')
    expect(JSON.parse(switchWrite.body).transformer._disabledModels).toEqual(['alpha', 'beta'])

    await page.getByRole('combobox', { name: 'Model the opus alias points at' }).selectOption('alpha')
    await page.waitForFunction(
      () =>
        document.querySelector('select[aria-label="Model the opus alias points at"]')?.getAttribute('disabled') === null
    )
    const tierWrite = writes[1]
    if (tierWrite === undefined) throw new Error('tier picker did not write')
    expect(tierWrite.method).toBe('PUT')
    expect(JSON.parse(tierWrite.body)).toEqual({ model: 'alpha' })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.getByRole('button', { name: 'Toggle beta' }).isVisible()).toBe(true)
    expect(await page.getByRole('combobox', { name: 'Model the opus alias points at' }).isVisible()).toBe(true)
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    expect(await page.getByRole('button', { name: 'Toggle beta' }).isDisabled()).toBe(true)
    expect(await page.getByRole('combobox', { name: 'Model the opus alias points at' }).count()).toBe(0)
    const refreshed: string[] = []
    await page.route('**/api/catalog/refresh', async (route) => {
      refreshed.push('catalog')
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })
    await page.route('**/api/refresh-models', async (route) => {
      refreshed.push('models')
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })
    await Promise.all([
      page.waitForResponse('**/api/refresh-models'),
      page.getByRole('button', { name: 'Refresh', exact: true }).click()
    ])
    expect(refreshed).toEqual(['catalog', 'models'])
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('main')
      return main === null ? 0 : main.scrollWidth - main.clientWidth
    })
    expect(overflow).toBe(0)
    await page.context().close()
  })

  // Once, not once per list. The two lists are the same component with a
  // different filter, and the console is shared with everything else the
  // app has open — a second window on it only doubles the chance of
  // catching a stray from an unrelated subsystem.
  test('renders with no console errors', async () => {
    const context = await browser().newContext()
    const page = await context.newPage()
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(`${E2E_BASE_URL}/setup`, { waitUntil: 'networkidle' })
    await page.goto(`${E2E_BASE_URL}/providers/subscriptions`, { waitUntil: 'networkidle' })
    expect(errors).toEqual([])
    await context.close()
  })
})
