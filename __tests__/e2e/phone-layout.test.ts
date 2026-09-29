/**
 * E2E for the phone layout.
 *
 * What broke on a phone was never one screen: every table overflowed its
 * pane sideways, and the folded rail spent a seventh of the width on
 * every page. So the rule pinned here is width-wide — at 390px no screen
 * in the shell may scroll sideways — plus the one piece of new chrome
 * that makes the rest reachable: the bottom bar and its More sheet stand
 * in for the sidebar, so every destination the sidebar holds has to be
 * one tap into the sheet.
 *
 * `main` is measured rather than the document: the shell is `h-dvh` with
 * its own scrolling region, so an overflowing table widens `main` and
 * leaves `documentElement` at exactly the viewport.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Browser, Page } from 'playwright'
import { E2E_BASE_URL, HAS_E2E, launchBrowser } from './helpers'

const PHONE = { width: 390, height: 844 }

const held: { browser: Browser | null } = { browser: null }

const browser = (): Browser => {
  if (held.browser === null) throw new Error('browser not started')
  return held.browser
}

/** The first-run gate bounces a bare context to /setup; pass through it. */
async function openPhone(path: string): Promise<Page> {
  const context = await browser().newContext({ viewport: PHONE, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  await page.goto(`${E2E_BASE_URL}/setup`, { waitUntil: 'networkidle' })
  await page.goto(`${E2E_BASE_URL}${path}`, { waitUntil: 'networkidle' })
  return page
}

/** Every list and top-level page in the shell. Detail pages need ids the
 *  suite cannot know in advance, so they are left to the screenshots. */
const ROUTES = [
  '/overview',
  '/routing',
  '/providers/subscriptions',
  '/providers/api-keys',
  '/providers/connect',
  '/access-tokens',
  '/access-tokens/plans',
  '/activity',
  '/activity/requests',
  '/activity/usage',
  '/activity/logs',
  '/settings',
  '/settings/access',
  '/settings/logging',
  '/settings/personas',
  '/settings/advanced'
] as const

describe.skipIf(!HAS_E2E)('Phone layout', () => {
  beforeAll(async () => {
    held.browser = await launchBrowser()
  })

  afterAll(async () => {
    if (held.browser !== null) await held.browser.close()
  })

  test('the sidebar gives way to the bottom bar', async () => {
    const page = await openPhone('/overview')
    expect(await page.locator('aside').isVisible()).toBe(false)
    for (const name of ['Overview', 'Providers', 'Tokens', 'Activity']) {
      expect(await page.getByRole('link', { name, exact: true }).isVisible()).toBe(true)
    }
    await page.close()
  })

  test('More reaches a page the bar does not carry, and closes behind it', async () => {
    const page = await openPhone('/overview')
    await page.getByRole('button', { name: 'More', exact: true }).tap()
    await page.getByRole('link', { name: 'Logging', exact: true }).tap()
    await page.waitForURL('**/settings/logging')
    await page.locator('[data-slot="sheet-content"]').waitFor({ state: 'detached' })
    expect(await page.locator('[data-slot="sheet-content"]').count()).toBe(0)
    await page.close()
  })

  for (const path of ROUTES) {
    test(`${path} does not scroll sideways`, async () => {
      const page = await openPhone(path)
      const overflow = await page.evaluate(() => {
        const main = document.querySelector('main')
        return main === null ? 0 : main.scrollWidth - main.clientWidth
      })
      expect(overflow).toBe(0)
      await page.close()
    })
  }
})
