/**
 * E2E for the shell's command palette (⌘K / Ctrl+K, or the search box at
 * the top of the sidebar).
 *
 * It shipped rendering cmdk's input and list straight inside the shadcn
 * `CommandDialog`, which is a plain Dialog that does not supply the cmdk
 * root those parts read their store from. Nothing failed until the palette
 * was opened; then the input threw during render ("Cannot read properties
 * of undefined (reading 'subscribe')") and the route's error boundary
 * replaced the whole screen. Opening it is the regression, so every test
 * here opens it first.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Browser, Page } from 'playwright'
import { E2E_BASE_URL, HAS_E2E, launchBrowser } from './helpers'

const held: { browser: Browser | null } = { browser: null }

const browser = (): Browser => {
  if (held.browser === null) throw new Error('browser not started')
  return held.browser
}

/** The first-run gate bounces a bare context to /setup; pass through it. */
async function openShell(): Promise<Page> {
  const context = await browser().newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${E2E_BASE_URL}/setup`, { waitUntil: 'networkidle' })
  await page.goto(`${E2E_BASE_URL}/overview`, { waitUntil: 'networkidle' })
  return page
}

const paletteInput = (page: Page) => page.locator('[data-slot="command-input"]')

describe.skipIf(!HAS_E2E)('Command palette', () => {
  beforeAll(async () => {
    held.browser = await launchBrowser()
  })

  afterAll(async () => {
    if (held.browser !== null) await held.browser.close()
  })

  test('Ctrl+K opens it without taking the screen down', async () => {
    const page = await openShell()
    await page.keyboard.press('Control+k')
    await paletteInput(page).waitFor({ state: 'visible' })

    // Asserted on the page, not on `pageerror`: the error boundary catches
    // a render error, so it reaches the console and never the window.
    expect(await page.locator('[cmdk-item]').count()).toBeGreaterThan(0)
    expect(await page.getByText('This screen failed to render').count()).toBe(0)
    await page.close()
  })

  test('the sidebar search box opens it too', async () => {
    const page = await openShell()
    await page.getByRole('button', { name: 'Search…', exact: true }).click()
    await paletteInput(page).waitFor({ state: 'visible' })
    expect(await paletteInput(page).count()).toBe(1)
    await page.close()
  })

  test('typing filters to a destination and Enter goes there', async () => {
    const page = await openShell()
    await page.keyboard.press('Control+k')
    await paletteInput(page).fill('settings logging')
    await page.keyboard.press('Enter')
    await page.waitForURL('**/settings/logging')
    expect(new URL(page.url()).pathname).toBe('/settings/logging')
    await paletteInput(page).waitFor({ state: 'detached' })
    await page.close()
  })
})
