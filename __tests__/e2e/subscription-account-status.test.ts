import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Browser } from 'playwright'
import type { AuthStatus, Provider, SubAccountWire } from '../../src/components/rialto/providers/types'
import dayjs from '../../src/lib/dayjs'
import { E2E_BASE_URL, HAS_E2E, launchBrowser } from './helpers'

const NAME = 'e2e-account-status'
const LONG_LABEL = `${'A very long subscription account name '.repeat(30)}last-word`
const ERROR = `UPSTREAM_PRIVATE_DIAGNOSTIC ${'<html><body>upstream gateway error</body></html>'.repeat(500)}`
const statuses: AuthStatus[] = ['live', 'invalid', 'unknown']
const accounts: SubAccountWire[] = statuses.map((authStatus) => ({
  id: authStatus,
  enabled: true,
  label: authStatus,
  sourcePath: `oauth:claude:${authStatus}`,
  userName: authStatus === 'invalid' ? LONG_LABEL : `${authStatus} account`,
  userEmail: null,
  userId: authStatus,
  plan: 'claude_max',
  rateLimitTier: 'default_claude_max_20x',
  monthlyPriceUsd: null,
  expiresAt: null,
  subscriptionEndsAt: null,
  authStatus,
  authCheckedAt: null,
  authError: authStatus === 'invalid' ? ERROR : null,
  scopes: []
}))
const provider: Provider = {
  name: NAME,
  enabled: true,
  auth_mode: 'subscription',
  api_base_url: 'https://api.anthropic.com',
  api_key: null,
  models: ['claude-sonnet-5'],
  subscription_accounts: accounts.map(({ id, enabled }) => ({ id, enabled }))
}

// Local response stubs only: neither credentials nor real account flags are changed.
describe.skipIf(!HAS_E2E)('subscription account status display', () => {
  const held: { browser: Browser | null } = { browser: null }
  beforeAll(async () => {
    held.browser = await launchBrowser()
  })
  afterAll(async () => {
    if (held.browser !== null) await held.browser.close()
  })

  for (const width of [1440, 390]) {
    test(`badges and long account labels stay compact at ${width}px`, async () => {
      if (held.browser === null) throw new Error('browser not started')
      const context = await held.browser.newContext({ viewport: { width, height: 900 } })
      const page = await context.newPage()
      const writes: string[] = []
      try {
        await page.goto(`${E2E_BASE_URL}/setup`, { waitUntil: 'networkidle' })
        const now = dayjs()
        const responses: Record<string, unknown> = {
          '/api/providers': [provider],
          '/api/subscriptions': { subscriptions: [{ providerName: NAME, kind: 'claude', enabled: true, accounts }] },
          '/api/catalog': { entries: [] },
          '/api/transformers': { transformers: [] },
          '/api/tier-aliases': [],
          '/api/overview': {
            generatedAt: now.toISOString(),
            providerCount: 1,
            enabledModelCount: 1,
            quota: accounts.map((account) => ({
              subAccountId: account.id,
              windows: [{ window: '5h', scope: null, pct: 42, resetAt: now.add(2, 'hour').toISOString() }],
              resetCredits: null
            }))
          }
        }
        await page.route('**/api/**', async (route) => {
          const request = route.request()
          if (request.method() !== 'GET') {
            writes.push(request.method())
            await route.fulfill({ status: 503, body: '{}' })
            return
          }
          const response = responses[new URL(request.url()).pathname]
          if (response === undefined) {
            await route.continue()
            return
          }
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) })
        })
        await page.goto(`${E2E_BASE_URL}/providers/${NAME}`, { waitUntil: 'networkidle' })
        const panel = page.getByRole('heading', { name: 'Accounts', exact: true }).locator('..').locator('..')
        await panel.getByText('valid', { exact: true }).waitFor({ state: 'visible' })
        for (const badge of ['valid', 'invalid', 'unknown']) {
          const label = panel.getByText(badge, { exact: true })
          expect(await label.count()).toBe(1)
          expect(await label.evaluate((node) => node.classList.contains('rounded'))).toBe(true)
        }
        expect(await panel.getByText('auth invalid', { exact: true }).count()).toBe(0)
        expect((await page.content()).includes('UPSTREAM_PRIVATE_DIAGNOSTIC')).toBe(false)
        const longLabel = panel.locator('[title]').filter({ hasText: LONG_LABEL })
        expect(await longLabel.getAttribute('title')).toBe(LONG_LABEL)
        expect(await longLabel.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true)
        for (const reset of await panel.getByText('resets in', { exact: true }).all()) {
          expect(await reset.evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('nowrap')
        }
        expect(await panel.getByText(/^\d+h \d{2}m$/).count()).toBe(3)
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        ).toBe(0)
        expect(writes).toEqual([])
      } finally {
        await context.close()
      }
    })
  }
})
