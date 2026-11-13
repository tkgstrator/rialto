import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Browser } from 'playwright'
import { E2E_BASE_URL, HAS_E2E, launchBrowser } from './helpers'

const held: { browser: Browser | null } = { browser: null }

const routes = {
  default: { agent: [], subagent: [] },
  think: { agent: [], subagent: [] },
  longContext: { agent: [], subagent: [] }
}

const constraints = {
  blockedEscalationTiers: [],
  exhaustedBehavior: '429',
  quotaSkipPct: 100,
  errorRateSkipPct: 0.5,
  minHealthSamples: 5,
  longContextThreshold: null,
  previousLongContextThreshold: null,
  longContextTunedAt: null,
  autoTuneLongContext: true,
  decisionApiBaseUrl: 'https://old.example',
  decisionApiKeyEnv: 'OLD_API_KEY',
  decisionEnabled: true,
  decisionMinConfidence: 0.9,
  decisionModel: 'old-model',
  decisionTimeoutMs: 1_500
}

describe.skipIf(!HAS_E2E)('Routing Decisions API editor', () => {
  beforeAll(async () => {
    held.browser = await launchBrowser()
  })

  afterAll(async () => {
    if (held.browser !== null) await held.browser.close()
  })

  test('saves the latest Decisions API fields when it is disabled', async () => {
    if (held.browser === null) throw new Error('browser not started')
    const page = await held.browser.newPage({ viewport: { width: 1280, height: 900 } })
    const profile = { key: 'live', routes, constraints, longContextThreshold: 100_000 }

    await page.route('**/api/config', async (route) => {
      await route.fulfill({
        json: {
          LOG: false,
          LOG_LEVEL: 'info',
          CLAUDE_PATH: '',
          HOST: '127.0.0.1',
          PORT: 3456,
          API_TIMEOUT_MS: 600_000,
          PROXY_URL: '',
          Providers: [
            {
              name: 'openai',
              enabled: true,
              api_base_url: 'https://api.openai.com/v1',
              api_key: 'test-key',
              auth_mode: 'api_key',
              api_style: 'openai_responses',
              models: ['gpt-test']
            }
          ],
          ActivePersona: null,
          Personas: []
        }
      })
    })
    await page.route('**/api/inbound-surfaces', async (route) => {
      await route.fulfill({
        json: {
          surfaces: [
            {
              id: 'openai-responses',
              path: '/v1/responses',
              client: 'OpenAI Responses',
              inboundType: 'openai',
              auth: 'bearer',
              errorShape: 'openai',
              routingMode: 'routed',
              profileKey: 'live',
              deniedTargets: []
            }
          ]
        }
      })
    })
    await page.route('**/api/routing/profiles', async (route) => {
      await route.fulfill({ json: [{ key: 'live', routeCount: 0, updatedAt: null, kind: 'map' }] })
    })
    await page.route('**/api/tier-aliases', async (route) => {
      await route.fulfill({ json: [] })
    })
    await page.route('**/api/routing/profiles/live', async (route) => {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON()
        profile.constraints.decisionEnabled = body.constraints.decisionEnabled
        await route.fulfill({ json: { success: true, warnings: [] } })
        return
      }
      await route.fulfill({ json: profile })
    })

    await page.goto(`${E2E_BASE_URL}/setup`, { waitUntil: 'networkidle' })
    await page.goto(`${E2E_BASE_URL}/routing`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Decisions API base URL').fill('')
    await page.getByLabel('Decision model').fill('new-model')
    await page.getByLabel('API key environment variable').fill('NEW_API_KEY')
    await page.getByLabel('Minimum confidence').fill('0.75')
    await page.getByLabel('Timeout (ms)').fill('2400')
    await page.getByRole('checkbox', { name: /Prefer tiers with a Decisions API/ }).uncheck()

    const put = page.waitForRequest(
      (request) => request.method() === 'PUT' && new URL(request.url()).pathname === '/api/routing/profiles/live'
    )
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const body = (await put).postDataJSON()

    expect(body.constraints.decisionEnabled).toBe(false)
    expect(body.constraints.decisionApiBaseUrl).toBe(null)
    expect(body.constraints.decisionModel).toBe('new-model')
    expect(body.constraints.decisionApiKeyEnv).toBe('NEW_API_KEY')
    expect(body.constraints.decisionMinConfidence).toBe(0.75)
    expect(body.constraints.decisionTimeoutMs).toBe(2_400)
    await page.close()
  })
})
