import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Browser } from 'playwright'
import type { ProviderPriorityGroupsResponse } from '../../src/api/providers/priorities'
import { E2E_BASE_URL, HAS_E2E, launchBrowser } from './helpers'

const held: { browser: Browser | null } = { browser: null }

describe.skipIf(!HAS_E2E)('Provider priorities screen', () => {
  beforeAll(async () => {
    held.browser = await launchBrowser()
  })

  afterAll(async () => {
    if (held.browser !== null) await held.browser.close()
  })

  test('reorders connections once per vendor', async () => {
    if (held.browser === null) throw new Error('browser not started')
    const page = await held.browser.newPage({ viewport: { width: 390, height: 844 } })
    const state: ProviderPriorityGroupsResponse = {
      groups: [
        {
          group: 'openai',
          providers: [
            { name: 'codex', organizationId: null, displayName: null },
            { name: 'openai', organizationId: null, displayName: null }
          ]
        },
        { group: 'anthropic', providers: [] }
      ]
    }
    const writes: unknown[] = []
    await page.route('**/api/providers/priorities', async (route) => {
      if (route.request().method() === 'PUT') {
        writes.push(route.request().postDataJSON())
        state.groups[0].providers.reverse()
        await route.fulfill({ json: { success: true } })
        return
      }
      await route.fulfill({ json: state })
    })
    await page.goto(`${E2E_BASE_URL}/setup`, { waitUntil: 'networkidle' })
    await page.goto(`${E2E_BASE_URL}/providers/priorities`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Anthropic', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Move OpenAI up', exact: true }).click()
    await page.getByText('Provider priority saved', { exact: true }).waitFor()
    expect(writes).toEqual([{ group: 'openai', providers: ['openai', 'codex'] }])
    expect(await page.getByRole('button', { name: 'Move OpenAI up', exact: true }).isDisabled()).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await page.close()
  })
})
