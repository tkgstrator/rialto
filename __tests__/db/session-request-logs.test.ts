/**
 * One session's routing trace and conversation, a page at a time.
 *
 * The endpoint used to return every row the session ever logged, and the
 * screen reversed them to oldest first — so on a long session the calls a
 * reader opened it for were the last rows of a very long table. It now
 * pages newest first, with `total` counting the whole session so the
 * footer can say "26–50 of 58".
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { z } from '@hono/zod-openapi'
import { Hono } from 'hono'
import { requestLogsRoute } from '../../src/api/request-logs/route'
import { getPrismaClient } from '../../src/db/client'
import dayjs from '../../src/lib/dayjs'
import {
  SessionLogsResponseSchema,
  SessionMessagesResponseSchema,
  SessionSummarySchema,
  SessionsResponseSchema
} from '../../src/schemas/api/request-log'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

const SESSION = 'sess-trace'
const OTHER = 'sess-other'

const page = async (sessionId: string, query: string): Promise<z.infer<typeof SessionLogsResponseSchema>> => {
  const app = new Hono()
  app.route('/', requestLogsRoute)
  const res = await app.fetch(new Request(`http://local/api/request-logs/sessions/${sessionId}?${query}`))
  expect(res.status).toBe(200)
  // Parsed rather than cast, so a response that lost `total` fails here.
  const parsed = SessionLogsResponseSchema.safeParse(await res.json())
  if (!parsed.success) throw parsed.error
  return parsed.data
}

/** `count` calls one minute apart, the last one a minute ago. */
const seed = async (sessionId: string, count: number): Promise<void> => {
  const prisma = getPrismaClient()
  await prisma.session.create({ data: { id: sessionId } })
  await prisma.requestLog.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      sessionId,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      status: 200,
      durationMs: 100,
      createdAt: dayjs()
        .subtract(count - i, 'minute')
        .toDate()
    }))
  })
}

describe.if(HAS_DB)('session request-log pages', () => {
  beforeEach(async () => {
    await resetDbTables()
  })

  afterAll(async () => {
    await resetDbTables()
    await teardownPrisma()
  })

  test('pages newest first, and total counts the whole session', async () => {
    await seed(SESSION, 30)
    await seed(OTHER, 4)

    const first = await page(SESSION, 'limit=25&offset=0')
    expect(first.total).toBe(30)
    expect(first.items).toHaveLength(25)
    const times = first.items.map((r) => Date.parse(r.createdAt))
    expect(times).toEqual([...times].sort((a, b) => b - a))
    // Another session's rows are neither on the page nor in the count.
    expect(first.items.every((r) => r.sessionId === SESSION)).toBe(true)

    const second = await page(SESSION, 'limit=25&offset=25')
    expect(second.total).toBe(30)
    expect(second.items).toHaveLength(5)
    expect(Date.parse(second.items[0].createdAt)).toBeLessThan(times[times.length - 1])
  })

  test('rows sharing a timestamp are split across pages without overlap', async () => {
    // A 429 and the failover that answered it can be logged in the same
    // millisecond; ordering on createdAt alone left their order to the
    // planner, so an offset page could repeat one and drop the other.
    const prisma = getPrismaClient()
    const at = dayjs().subtract(1, 'minute').toDate()
    await prisma.session.create({ data: { id: SESSION } })
    await prisma.requestLog.createMany({
      data: Array.from({ length: 6 }, () => ({
        sessionId: SESSION,
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        status: 200,
        durationMs: 100,
        createdAt: at
      }))
    })

    const pages = await Promise.all([0, 2, 4].map((offset) => page(SESSION, `limit=2&offset=${offset}`)))
    const ids = pages.flatMap((p) => p.items.map((r) => r.id))
    expect(ids).toHaveLength(6)
    expect(new Set(ids).size).toBe(6)
  })
})

/**
 * The reasoning effort a call was sent with is written by `captureUsage`,
 * stored in a nullable TEXT column and read back on three endpoints: the
 * session's trace, and the session list and summary that fold it into a
 * split. A row with none recorded must stay "none" through all of them.
 */
describe.if(HAS_DB)('reasoning effort round trip', () => {
  const callAt = (minutesAgo: number, reasoningEffort: string | null) => ({
    sessionId: SESSION,
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    status: 200,
    durationMs: 100,
    reasoningEffort,
    createdAt: dayjs().subtract(minutesAgo, 'minute').toDate()
  })

  // Newest first: xhigh, high, high, then two with nothing recorded.
  const seedEfforts = async (): Promise<void> => {
    const prisma = getPrismaClient()
    await prisma.session.create({ data: { id: SESSION } })
    await prisma.requestLog.createMany({
      data: [callAt(1, 'xhigh'), callAt(2, 'high'), callAt(3, 'high'), callAt(4, null), callAt(5, null)]
    })
  }

  const get = async (path: string): Promise<unknown> => {
    const app = new Hono()
    app.route('/', requestLogsRoute)
    const res = await app.fetch(new Request(`http://local${path}`))
    expect(res.status).toBe(200)
    return res.json()
  }

  beforeEach(async () => {
    await resetDbTables()
    await seedEfforts()
  })

  afterAll(async () => {
    await resetDbTables()
    await teardownPrisma()
  })

  test('the trace returns each call with the effort it was sent at, null where none was', async () => {
    const calls = await page(SESSION, 'limit=25&offset=0')
    expect(calls.items.map((r) => r.reasoningEffort)).toEqual(['xhigh', 'high', 'high', null, null])
  })

  test('the flat request log carries it too', async () => {
    const parsed = SessionLogsResponseSchema.safeParse(await get('/api/request-logs?limit=10'))
    if (!parsed.success) throw parsed.error
    expect(parsed.data.items.map((r) => r.reasoningEffort)).toEqual(['xhigh', 'high', 'high', null, null])
  })

  test('the session list splits its calls by effort, busiest first, without counting the unrecorded', async () => {
    const parsed = SessionsResponseSchema.safeParse(await get('/api/request-logs/sessions?sinceHours=0'))
    if (!parsed.success) throw parsed.error
    expect(parsed.data.sessions).toHaveLength(1)
    expect(parsed.data.sessions[0].requestCount).toBe(5)
    expect(parsed.data.sessions[0].efforts).toEqual([
      { name: 'high', requests: 2 },
      { name: 'xhigh', requests: 1 }
    ])
  })

  test('the summary the live list patches in from carries the same split', async () => {
    const parsed = SessionSummarySchema.safeParse(await get(`/api/request-logs/sessions/${SESSION}/summary`))
    if (!parsed.success) throw parsed.error
    expect(parsed.data.efforts).toEqual([
      { name: 'high', requests: 2 },
      { name: 'xhigh', requests: 1 }
    ])
  })

  test('a session none of whose calls recorded an effort has an empty split', async () => {
    await resetDbTables()
    const prisma = getPrismaClient()
    await prisma.session.create({ data: { id: OTHER } })
    await prisma.requestLog.createMany({
      data: [
        { ...callAt(1, null), sessionId: OTHER },
        { ...callAt(2, null), sessionId: OTHER }
      ]
    })
    const parsed = SessionSummarySchema.safeParse(await get(`/api/request-logs/sessions/${OTHER}/summary`))
    if (!parsed.success) throw parsed.error
    expect(parsed.data.efforts).toEqual([])
  })
})

/**
 * The same session's conversation, paged the same way for its tab. The
 * `before` cursor a chat-style reader walks with must keep working beside
 * the new `offset`.
 */
describe.if(HAS_DB)('session message pages', () => {
  const messagePage = async (query: string): Promise<z.infer<typeof SessionMessagesResponseSchema>> => {
    const app = new Hono()
    app.route('/', requestLogsRoute)
    const res = await app.fetch(new Request(`http://local/api/request-logs/sessions/${SESSION}/messages?${query}`))
    expect(res.status).toBe(200)
    const parsed = SessionMessagesResponseSchema.safeParse(await res.json())
    if (!parsed.success) throw parsed.error
    return parsed.data
  }

  /** Messages `m01`…`m07`, one minute apart, `m07` the newest. */
  const seedMessages = async (): Promise<void> => {
    const prisma = getPrismaClient()
    await prisma.session.create({ data: { id: SESSION } })
    await prisma.message.createMany({
      data: Array.from({ length: 7 }, (_, i) => ({
        sessionId: SESSION,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `m${String(i + 1).padStart(2, '0')}`,
        createdAt: dayjs()
          .subtract(7 - i, 'minute')
          .toDate()
      }))
    })
  }

  beforeEach(async () => {
    await resetDbTables()
    await seedMessages()
  })

  afterAll(async () => {
    await resetDbTables()
    await teardownPrisma()
  })

  test('offset pages count from the newest message, and total is the whole session', async () => {
    const first = await messagePage('limit=3&offset=0')
    const second = await messagePage('limit=3&offset=3')
    const last = await messagePage('limit=3&offset=6')
    expect([first.total, second.total, last.total]).toEqual([7, 7, 7])
    // Each page still reads oldest-first on the wire.
    expect(first.items.map((m) => m.content)).toEqual(['m05', 'm06', 'm07'])
    expect(second.items.map((m) => m.content)).toEqual(['m02', 'm03', 'm04'])
    expect(last.items.map((m) => m.content)).toEqual(['m01'])
  })

  test('the before cursor still walks older windows', async () => {
    const newest = await messagePage('limit=3')
    expect(newest.nextCursor).not.toBeNull()
    const older = await messagePage(`limit=3&before=${newest.nextCursor}`)
    expect(older.items.map((m) => m.content)).toEqual(['m02', 'm03', 'm04'])
  })
})
