import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Browser } from 'playwright'
import type { ModelProviderPrioritiesResponse } from '../../src/schemas/api/model-provider-priorities'
import { E2E_BASE_URL, HAS_E2E, launchBrowser } from './helpers'

const held: { browser: Browser | null } = { browser: null }

describe.skipIf(!HAS_E2E)('Provider priorities screen', () => {
  beforeAll(async () => {
    held.browser = await launchBrowser()
  })

  afterAll(async () => {
    if (held.browser !== null) await held.browser.close()
  })

  test('sets a duplicate model priority without exposing a qualified public model id', async () => {
    if (held.browser === null) throw new Error('browser not started')
    const page = await held.browser.newPage({ viewport: { width: 390, height: 844 } })
    const state: ModelProviderPrioritiesResponse = {
      models: [{ model: 'gpt-5.6-sol', providers: ['codex', 'openai'], preferredProviders: [] }]
    }
    const writes: string[][] = []
    await page.route('**/api/models/provider-priorities', async (route) => {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON()
        writes.push(body.providers)
        state.models[0].providers = body.providers
        state.models[0].preferredProviders = body.providers
        await route.fulfill({ json: { success: true } })
        return
      }
      await route.fulfill({ json: state })
    })
    await page.goto(`${E2E_BASE_URL}/setup`, { waitUntil: 'networkidle' })
    await page.goto(`${E2E_BASE_URL}/providers/priorities`, { waitUntil: 'networkidle' })
    await page.getByRole('combobox', { name: 'Primary provider for gpt-5.6-sol' }).waitFor()
    expect(await page.getByText('needs priority').count()).toBe(1)
    await page.getByRole('combobox', { name: 'Primary provider for gpt-5.6-sol' }).selectOption('openai')
    await page.getByText('configured', { exact: true }).waitFor()
    expect(writes).toEqual([['openai', 'codex']])
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await page.close()
  })
})
