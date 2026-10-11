import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Browser, Page } from 'playwright'
import { E2E_BASE_URL, HAS_E2E, launchBrowser } from './helpers'

const held: { browser: Browser | null } = { browser: null }
const sectionRuleCount = (page: Page) =>
  page.locator('main section').evaluateAll(
    (sections) =>
      sections.filter((section) => {
        const style = getComputedStyle(section)
        return [style.borderTopWidth, style.borderBottomWidth, style.borderLeftWidth].some(
          (width) => Number.parseFloat(width) > 0
        )
      }).length
  )

async function expectPaneLayout(page: Page, width: number, columns: boolean) {
  // One frame keeps the measurements coherent during sidebar transitions.
  const bounds = await page.evaluate(() => {
    const form = document.querySelector('#decision-form')
    const input = form?.closest('section')
    const result = document.querySelector('main section[aria-live="polite"]')
    const textarea = form?.querySelector('textarea')
    const question = form?.querySelector('input')
    if (!input || !result || !textarea || !question) return null
    const rect = (node: Element) => {
      const { x, y, width, height } = node.getBoundingClientRect()
      return { x, y, width, height }
    }
    return { inputPane: rect(input), resultPane: rect(result), situation: rect(textarea), question: rect(question) }
  })
  if (bounds === null) throw new Error('expected both panes and their controls')
  const { inputPane, resultPane, situation, question } = bounds
  if (columns) {
    expect(Math.abs(inputPane.y - resultPane.y)).toBeLessThan(1)
    expect(resultPane.x).toBeGreaterThanOrEqual(inputPane.x + inputPane.width - 1)
    expect(inputPane.width / resultPane.width).toBeCloseTo(1.5, 1)
  } else {
    expect(resultPane.y).toBeGreaterThanOrEqual(inputPane.y + inputPane.height - 1)
    expect(resultPane.width).toBeCloseTo(inputPane.width, 1)
  }
  const gutters = width < 768 ? 32 : 48
  expect(situation.width).toBeCloseTo(inputPane.width - gutters, 1)
  expect(question.width).toBeCloseTo(situation.width, 1)
}

describe.skipIf(!HAS_E2E)('Decisions screen', () => {
  beforeAll(async () => {
    held.browser = await launchBrowser()
  })

  afterAll(async () => {
    if (held.browser !== null) await held.browser.close()
  })

  test('the sidebar opens the admin playground without a Jeff server', async () => {
    if (held.browser === null) throw new Error('browser not started')
    const page = await held.browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(`${E2E_BASE_URL}/setup`, { waitUntil: 'networkidle' })
    await page.goto(`${E2E_BASE_URL}/overview`, { waitUntil: 'networkidle' })
    await page.getByRole('link', { name: 'Decisions', exact: true }).click()
    await page.waitForURL('**/decisions')
    await page.getByRole('heading', { name: 'Decision service' }).waitFor()
    expect(await page.getByRole('heading', { name: 'Decision service' }).count()).toBe(1)
    expect(await page.getByLabel('Situation (English)').count()).toBe(1)
    expect(await page.getByRole('button', { name: 'Run decision' }).isDisabled()).toBe(true)
    await page.getByLabel('Question type').selectOption('noul')
    expect(await page.getByLabel('Option 1', { exact: true }).count()).toBe(0)
    await page.getByLabel('Question type').selectOption('score')
    expect(await page.getByLabel('Option 1', { exact: true }).count()).toBe(1)
    await page.getByRole('button', { name: 'Add option' }).click()
    expect(await page.getByLabel('Option 3', { exact: true }).count()).toBe(1)
    await page.close()
  })

  for (const width of [1440, 1920, 1100, 390]) {
    test(`connection details and an empty result use only two section rules at ${width}px`, async () => {
      if (held.browser === null) throw new Error('browser not started')
      const context = await held.browser.newContext({ viewport: { width, height: 900 } })
      const page = await context.newPage()
      try {
        await page.goto(`${E2E_BASE_URL}/setup`, { waitUntil: 'networkidle' })
        await page.route('**/api/decisions/status', async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              configured: true,
              ready: false,
              shadowEnabled: false,
              model: 'jeff-test',
              error: 'Connection unavailable'
            })
          })
        })
        await page.goto(`${E2E_BASE_URL}/decisions`, { waitUntil: 'networkidle' })
        await page.getByRole('alert').waitFor({ state: 'visible' })
        expect(await sectionRuleCount(page)).toBe(2)
        await expectPaneLayout(page, width, width >= 1440)
        expect(await page.getByRole('heading', { name: 'Decision service', exact: true }).count()).toBe(1)
        expect(await page.getByRole('heading', { name: 'Result', exact: true }).count()).toBe(1)
        expect(await page.getByRole('alert').textContent()).toBe('Connection unavailable')
        expect(await page.getByText('jeff-test', { exact: true }).isVisible()).toBe(true)
        expect(await page.getByText('Submit a situation to see probabilities here.', { exact: true }).isVisible()).toBe(
          true
        )
        for (const label of ['Situation (English)', 'Question type', 'Question (English)', 'Option 1']) {
          expect(
            await page.getByLabel(label, { exact: true }).evaluate((node) => getComputedStyle(node).borderTopWidth)
          ).toBe('1px')
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        ).toBe(0)
        if (width === 1100) {
          // The viewport stays fixed; only the available pane width changes.
          await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
          await page.waitForFunction(() => {
            const input = document.querySelector('#decision-form')?.closest('section')
            const result = document.querySelector('main section[aria-live="polite"]')
            if (input === null || input === undefined || result === null) return false
            return Math.abs(input.getBoundingClientRect().y - result.getBoundingClientRect().y) < 1
          })
          await expectPaneLayout(page, width, true)
          expect(await sectionRuleCount(page)).toBe(2)
        }
      } finally {
        await context.close()
      }
    })
  }

  test('successful results and evaluation errors do not add section rules', async () => {
    if (held.browser === null) throw new Error('browser not started')
    const context = await held.browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const state: { fail: boolean; writes: unknown[] } = { fail: false, writes: [] }
    try {
      await page.goto(`${E2E_BASE_URL}/setup`, { waitUntil: 'networkidle' })
      await page.route('**/api/decisions/status', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ configured: true, ready: true, shadowEnabled: false, model: 'jeff-test', error: null })
        })
      })
      // Evaluation is local to this browser; no live decision service is called.
      await page.route('**/api/decisions/evaluate', async (route) => {
        const body = route.request().postData()
        if (body === null) throw new Error('decision request has no body')
        state.writes.push(JSON.parse(body))
        await route.fulfill({
          status: state.fail ? 503 : 200,
          contentType: 'application/json',
          body: JSON.stringify(
            state.fail
              ? { error: 'Decision unavailable' }
              : {
                  model: 'jeff-test',
                  answers: {
                    task: { type: 'choice', choice: '1', confidence: 0.8, probabilities: { '1': 0.8, '2': 0.2 } }
                  },
                  usage: { input_tokens: 25, output_tokens: 0 }
                }
          )
        })
      })
      await page.goto(`${E2E_BASE_URL}/decisions`, { waitUntil: 'networkidle' })
      await page.getByLabel('Situation (English)').fill('Please summarize these notes.')
      await page.getByRole('button', { name: 'Run decision', exact: true }).click()
      await page.getByText('1 · 80.0%', { exact: true }).waitFor({ state: 'visible' })
      expect(await sectionRuleCount(page)).toBe(2)
      expect(await page.getByText('A request to explain or summarize information', { exact: true }).isVisible()).toBe(
        true
      )
      expect(await page.getByText('jeff-test · 25 input tokens', { exact: true }).isVisible()).toBe(true)
      expect(state.writes[0]).toEqual({
        model: 'jeff-latest',
        state: 'Please summarize these notes.',
        questions: {
          task: {
            type: 'choice',
            instructions: 'Which option best describes the subagent task?',
            criteria: {
              '1': 'A request to explain or summarize information',
              '2': 'A task that requires multi-step reasoning'
            }
          }
        }
      })
      state.fail = true
      await page.getByRole('button', { name: 'Run decision', exact: true }).click()
      await page.getByRole('alert').waitFor({ state: 'visible' })
      expect(await page.getByRole('alert').textContent()).toBe('Decision unavailable')
      expect(await sectionRuleCount(page)).toBe(2)
      expect(state.writes).toHaveLength(2)
    } finally {
      await context.close()
    }
  })

  test('the form fits a phone viewport', async () => {
    if (held.browser === null) throw new Error('browser not started')
    const page = await held.browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.goto(`${E2E_BASE_URL}/setup`, { waitUntil: 'networkidle' })
    await page.goto(`${E2E_BASE_URL}/decisions`, { waitUntil: 'networkidle' })
    await page.getByLabel('Situation (English)').waitFor()
    const width = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(width).toBeLessThanOrEqual(390)
    await page.close()
  })
})
