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
