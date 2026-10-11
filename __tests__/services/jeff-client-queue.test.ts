/**
 * Jeff answers an overlapping evaluation with HTTP 529 instead of queueing it,
 * so Rialto makes callers take turns. fetch is stubbed throughout: no real Jeff.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import dayjs from '../../src/lib/dayjs'
import { __resetJeffQueueForTest, evaluateWithJeff, getJeffStatus } from '../../src/services/jeff-client'

const originalFetch = globalThis.fetch
const originalUrl = process.env.JEFF_URL

const question = {
  type: 'choice' as const,
  instructions: 'Which?',
  criteria: { a: 'A', b: 'B' }
}
const input = (name: string) => ({ state: name, model: 'jeff-latest', questions: { task: question } })
const answer = {
  model: 'jeff-qwen3.5-0.8b',
  answers: { task: { type: 'choice', choice: 'a', confidence: 0.6, probabilities: { a: 0.6, b: 0.4 } } },
  usage: { input_tokens: 5, output_tokens: 0 }
}

// A fetch whose responses are released by hand, so a test decides when each
// evaluation "finishes" and can observe how many are in flight at once.
function controlledFetch() {
  const started: string[] = []
  const log = { started, inFlight: 0, maxInFlight: 0 }
  const releases: Array<(response: Response) => void> = []
  const fake = (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    log.started.push(JSON.parse(String(init?.body)).state)
    log.inFlight++
    log.maxInFlight = Math.max(log.maxInFlight, log.inFlight)
    return new Promise((resolve) => {
      releases.push((response) => {
        log.inFlight--
        resolve(response)
      })
    })
  }
  globalThis.fetch = Object.assign(fake, { preconnect: originalFetch.preconnect })
  return { log, finish: (index: number, response = Response.json(answer)) => releases[index](response) }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  process.env.JEFF_URL = 'http://127.0.0.1:8000'
  __resetJeffQueueForTest()
})

afterEach(() => {
  __resetJeffQueueForTest()
  globalThis.fetch = originalFetch
  if (originalUrl === undefined) delete process.env.JEFF_URL
  else process.env.JEFF_URL = originalUrl
})

test('overlapping evaluations reach Jeff one at a time, in arrival order', async () => {
  const jeff = controlledFetch()
  const results = ['one', 'two', 'three'].map((name) => evaluateWithJeff(input(name)))
  await tick()
  expect(jeff.log.started).toEqual(['one'])
  jeff.finish(0)
  await tick()
  expect(jeff.log.started).toEqual(['one', 'two'])
  jeff.finish(1)
  await tick()
  expect(jeff.log.started).toEqual(['one', 'two', 'three'])
  jeff.finish(2)
  expect((await Promise.all(results)).every((result) => result.ok)).toBe(true)
  expect(jeff.log.maxInFlight).toBe(1)
})

test('a failed or timed-out evaluation still frees its turn for the next one', async () => {
  const jeff = controlledFetch()
  const first = evaluateWithJeff(input('one'))
  const second = evaluateWithJeff(input('two'))
  await tick()
  jeff.finish(0, Response.json({ detail: 'private' }, { status: 500 }))
  expect(await first).toEqual({ ok: false, error: 'Jeff returned HTTP 500.' })
  await tick()
  expect(jeff.log.started).toEqual(['one', 'two'])
  jeff.finish(1)
  expect((await second).ok).toBe(true)

  // A request that throws (network failure or the abort timeout) releases too.
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error('private upstream detail')
    },
    { preconnect: originalFetch.preconnect }
  )
  expect(await evaluateWithJeff(input('three'))).toEqual({ ok: false, error: 'Jeff is unavailable or timed out.' })
  const next = controlledFetch()
  const after = evaluateWithJeff(input('four'))
  await tick()
  expect(next.log.started).toEqual(['four'])
  next.finish(0)
  expect((await after).ok).toBe(true)
})

test('the evaluation timeout starts at its turn, not while waiting in line', async () => {
  const jeff = controlledFetch()
  const timeout = spyOn(AbortSignal, 'timeout')
  try {
    const first = evaluateWithJeff(input('one'))
    const second = evaluateWithJeff(input('two'))
    await tick()
    // Only the running evaluation has armed a timeout; the queued one has not.
    expect(timeout.mock.calls).toHaveLength(1)
    jeff.finish(0)
    await first
    await tick()
    expect(timeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([5_000, 5_000])
    jeff.finish(1)
    await second
  } finally {
    timeout.mockRestore()
  }
})

test('a caller that waits longer than its limit gives up and leaves the line', async () => {
  const jeff = controlledFetch()
  const running = evaluateWithJeff(input('one'))
  await tick()
  const impatient = await evaluateWithJeff(input('two'), { maxWaitMs: 20 })
  expect(impatient).toEqual({ ok: false, error: 'Jeff is busy with other evaluations.' })
  // The abandoned request never takes a turn: the next in line is the one that is still waiting.
  const patient = evaluateWithJeff(input('three'))
  jeff.finish(0)
  await running
  await tick()
  expect(jeff.log.started).toEqual(['one', 'three'])
  jeff.finish(1)
  expect((await patient).ok).toBe(true)
})

test('a full line fails fast instead of queueing without bound', async () => {
  const jeff = controlledFetch()
  const running = evaluateWithJeff(input('running'))
  const waiting = Array.from({ length: 8 }, (_, i) => evaluateWithJeff(input(`wait-${i}`)))
  await tick()
  const overflow = await evaluateWithJeff(input('overflow'))
  expect(overflow).toEqual({ ok: false, error: 'Jeff is busy with other evaluations.' })
  expect(jeff.log.started).toEqual(['running'])
  __resetJeffQueueForTest()
  jeff.finish(0)
  await running
  expect((await Promise.all(waiting)).every((result) => !result.ok)).toBe(true)
})

test('a 529 is retried once, after the Retry-After the upstream asked for', async () => {
  const calls: number[] = []
  globalThis.fetch = Object.assign(
    async () => {
      calls.push(dayjs().valueOf())
      if (calls.length === 1) return new Response('busy', { status: 529, headers: { 'Retry-After': '1' } })
      return Response.json(answer)
    },
    { preconnect: originalFetch.preconnect }
  )
  const result = await evaluateWithJeff(input('one'))
  expect(result.ok).toBe(true)
  expect(calls).toHaveLength(2)
  expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(900)
})

test('a second 529 is returned as the failure, with no third attempt', async () => {
  const attempts: number[] = []
  globalThis.fetch = Object.assign(
    async () => {
      attempts.push(attempts.length + 1)
      return new Response('busy', { status: 529, headers: { 'Retry-After': '0' } })
    },
    { preconnect: originalFetch.preconnect }
  )
  expect(await evaluateWithJeff(input('one'))).toEqual({ ok: false, error: 'Jeff returned HTTP 529.' })
  expect(attempts).toHaveLength(2)
})

test('a Retry-After longer than the wait left is not waited out', async () => {
  const attempts: number[] = []
  globalThis.fetch = Object.assign(
    async () => {
      attempts.push(attempts.length + 1)
      return new Response('busy', { status: 529, headers: { 'Retry-After': '30' } })
    },
    { preconnect: originalFetch.preconnect }
  )
  const started = dayjs().valueOf()
  expect(await evaluateWithJeff(input('one'), { maxWaitMs: 100 })).toEqual({
    ok: false,
    error: 'Jeff returned HTTP 529.'
  })
  expect(attempts).toHaveLength(1)
  expect(dayjs().valueOf() - started).toBeLessThan(1_000)
})

test('health checks never wait behind an evaluation', async () => {
  const jeff = controlledFetch()
  const running = evaluateWithJeff(input('one'))
  await tick()
  globalThis.fetch = Object.assign(
    async (): Promise<Response> => Response.json({ status: 'ready', model: 'jeff-qwen3.5-0.8b' }),
    { preconnect: originalFetch.preconnect }
  )
  expect((await getJeffStatus()).ready).toBe(true)
  jeff.finish(0)
  await running
})
