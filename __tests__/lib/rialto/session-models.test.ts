/**
 * Which model a session row names.
 *
 * A session is not one model — routing moves it between them turn by
 * turn, and on the demo install 45 of 56 sessions used two or more. The
 * list screen showed `models[0]` of a `new Set()` built over a Prisma
 * include with no `orderBy`, so the name on the row was whichever log
 * Postgres happened to return first: not the first model, not the main
 * one, and free to change between two loads of the same page. It also
 * disagreed with the Model filter beside it, which has always matched
 * against the whole set.
 */
import { describe, expect, test } from 'bun:test'
import { modelUsage } from '../../../src/api/request-logs/sessions'
import { ALL, applyFilters, type Enriched, enrich } from '../../../src/components/rialto/activity/sessions-derive'
import type { SessionSummary } from '../../../src/lib/api'

const logs = (...models: string[]) => models.map((model) => ({ model }))

const session = (models: Array<{ name: string; requests: number }>): SessionSummary => ({
  sessionId: 's1',
  inboundType: 'anthropic',
  surface: 'anthropic-messages',
  requestCount: models.reduce((sum, m) => sum + m.requests, 0),
  providers: ['claude-code'],
  models,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  avgCacheHitPct: 0,
  totalDurationMs: 0,
  totalCostUsd: null,
  firstAt: '2026-09-10T00:00:00.000Z',
  lastAt: '2026-09-10T00:10:00.000Z',
  preview: null
})

const rowsOf = (models: Array<{ name: string; requests: number }>): Enriched[] => enrich([session(models)], () => null)

describe('modelUsage', () => {
  test('counts each model and puts the busiest first', () => {
    expect(modelUsage(logs('haiku', 'opus', 'opus', 'sonnet', 'opus', 'sonnet'))).toEqual([
      { name: 'opus', requests: 3 },
      { name: 'sonnet', requests: 2 },
      { name: 'haiku', requests: 1 }
    ])
  })

  test('breaks a tie on the name, so two loads of a page agree', () => {
    // The whole point: the input arrives in whatever order Postgres
    // returned it, and the output may not depend on that order.
    expect(modelUsage(logs('sonnet', 'opus')).map((m) => m.name)).toEqual(['opus', 'sonnet'])
    expect(modelUsage(logs('opus', 'sonnet')).map((m) => m.name)).toEqual(['opus', 'sonnet'])
  })

  test('a session with no logs has no models', () => {
    expect(modelUsage([])).toEqual([])
  })
})

describe('enrich', () => {
  test('names the busiest model and counts the rest', () => {
    const [row] = rowsOf([
      { name: 'claude-opus-5', requests: 4 },
      { name: 'claude-sonnet-5', requests: 1 },
      { name: 'gemini-3.5-flash-lite', requests: 1 }
    ])
    expect(row.model).toBe('claude-opus-5')
    expect(row.otherModels).toBe(2)
  })

  test('a single-model session says so by having nothing to add', () => {
    const [row] = rowsOf([{ name: 'claude-sonnet-5', requests: 3 }])
    expect(row.otherModels).toBe(0)
  })

  test('a session whose requests recorded no model at all', () => {
    const [row] = rowsOf([])
    expect(row.model).toBeNull()
    expect(row.otherModels).toBe(0)
  })
})

describe('the Model filter', () => {
  test('matches a model the row does not display', () => {
    // The filter has always searched the whole set. Keeping the row while
    // the cell named something else is what made the column look broken.
    const rows = rowsOf([
      { name: 'claude-opus-5', requests: 4 },
      { name: 'gpt-5.6-terra', requests: 1 }
    ])
    const kept = applyFilters(rows, { surface: ALL, provider: ALL, model: 'gpt-5.6-terra' })
    expect(kept).toHaveLength(1)
    expect(kept[0].model).toBe('claude-opus-5')
  })

  test('drops a session that never touched the model', () => {
    const rows = rowsOf([{ name: 'claude-opus-5', requests: 4 }])
    expect(applyFilters(rows, { surface: ALL, provider: ALL, model: 'gpt-5.6-terra' })).toHaveLength(0)
  })
})
