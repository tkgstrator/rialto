/**
 * E2E for the collapsible sidebar.
 *
 * The rail is the state where the shell has the least to work with: every
 * row loses its label, so anything that identified a destination by text
 * — a screen reader, or a test — has nothing left unless the row carries
 * an `aria-label`. That is not a hypothetical: the first version of this
 * feature shipped icon-only links with no accessible name at all, and the
 * gap surfaced as a test that could no longer find "Providers".
 *
 * The widths are asserted as numbers because they are the feature: `w-64`
 * (256px) open, `w-14` (56px) collapsed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Browser, Page } from 'playwright'
import { E2E_BASE_URL, HAS_E2E, launchBrowser } from './helpers'

const OPEN_WIDTH = 256
const RAIL_WIDTH = 56

const held: { browser: Browser | null } = { browser: null }

const browser = (): Browser => {
  if (held.browser === null) throw new Error('browser not started')
  return held.browser
}

/** The first-run gate bounces a bare context to /setup; pass through it. */
async function openShell(viewport: { width: number; height: number }): Promise<Page> {
  const context = await browser().newContext({ viewport })
  const page = await context.newPage()
  await page.goto(`${E2E_BASE_URL}/setup`, { waitUntil: 'networkidle' })
  await page.goto(`${E2E_BASE_URL}/overview`, { waitUntil: 'networkidle' })
  return page
}

/** Waits out the width transition rather than sampling mid-animation. */
async function expectWidth(page: Page, width: number): Promise<void> {
  await page.waitForFunction((expected) => {
    const aside = document.querySelector('aside')
    return aside !== null && Math.round(aside.getBoundingClientRect().width) === expected
  }, width)
  expect(true).toBe(true)
}

describe.skipIf(!HAS_E2E)('Sidebar collapse', () => {
  beforeAll(async () => {
    held.browser = await launchBrowser()
  })

  afterAll(async () => {
    if (held.browser !== null) await held.browser.close()
  })

  test('the header button collapses to the rail and the rail expands back', async () => {
    const page = await openShell({ width: 1440, height: 900 })
    await expectWidth(page, OPEN_WIDTH)

    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    await expectWidth(page, RAIL_WIDTH)

    await page.getByRole('button', { name: 'Expand sidebar' }).click()
    await expectWidth(page, OPEN_WIDTH)
    await page.close()
  })

  test('⌘B / Ctrl+B toggles it', async () => {
    const page = await openShell({ width: 1440, height: 900 })
    await page.keyboard.press('Control+b')
    await expectWidth(page, RAIL_WIDTH)
    await page.keyboard.press('Control+b')
    await expectWidth(page, OPEN_WIDTH)
    await page.close()
  })

  test('a narrow window starts collapsed', async () => {
    const page = await openShell({ width: 900, height: 900 })
    await expectWidth(page, RAIL_WIDTH)
    await page.close()
  })

  test('every rail destination keeps an accessible name', async () => {
    const page = await openShell({ width: 900, height: 900 })
    await expectWidth(page, RAIL_WIDTH)
    for (const name of ['Overview', 'Routing', 'Providers']) {
      expect(await page.getByRole('link', { name, exact: true }).count()).toBe(1)
    }
    // A section with a second level trades its link for the button that
    // opens that level. The name has to survive the trade — losing it
    // here is the same regression as losing it on a link.
    for (const name of ['Activity', 'Settings']) {
      expect(await page.getByRole('button', { name, exact: true }).count()).toBe(1)
    }
    await page.close()
  })

  /**
   * The reason the flyout exists. A narrow window folds the sidebar by
   * itself and the sidebar is the app's only navigation, so without this
   * path Settings' six screens and Activity's four are reachable from the
   * rail only through the command palette — a keyboard affordance on the
   * one class of device that has no keyboard.
   */
  test('a folded section still reaches its own pages', async () => {
    const page = await openShell({ width: 900, height: 900 })
    await expectWidth(page, RAIL_WIDTH)

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('link', { name: 'Logging', exact: true }).click()
    await page.waitForURL('**/settings/logging')
    expect(new URL(page.url()).pathname).toBe('/settings/logging')

    // And closes behind the row it was used for, rather than sitting over
    // the screen it just navigated to.
    await page.locator('[data-slot="popover-content"]').waitFor({ state: 'detached' })
    expect(await page.locator('[data-slot="popover-content"]').count()).toBe(0)
    await page.close()
  })
})
