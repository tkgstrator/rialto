/** Jeff is an admin-only upstream, not an LLM inbound surface or a browser-configurable proxy. */
import { z } from '@hono/zod-openapi'
import dayjs from '../lib/dayjs'
import {
  type DecisionEvaluateRequest,
  type DecisionEvaluateResponse,
  DecisionEvaluateResponseSchema
} from '../schemas/api/decisions'

const HEALTH_TIMEOUT_MS = 3_000
// Counted from the moment an evaluation gets its turn, never from when it was
// queued: time spent behind another evaluation is not Jeff being slow.
const EVALUATION_TIMEOUT_MS = 5_000
// How long a caller may wait for its turn (plus any 529 back-off) before giving up.
const DEFAULT_MAX_WAIT_MS = 15_000
// A bounded line: beyond this, a caller is told Jeff is busy at once instead of
// piling up requests that would only time out in the queue.
const MAX_QUEUED = 8
const DEFAULT_RETRY_AFTER_MS = 1_000
const BUSY_ERROR = 'Jeff is busy with other evaluations.'

// Jeff evaluates one request at a time and answers a second, overlapping one with
// HTTP 529 instead of queueing it. Callers (several subagents, the playground)
// can overlap, so evaluations take turns here, first come first served.
//
// The state is held on globalThis so a hot-reloaded copy of this module joins the
// same line rather than starting a second one that would let two evaluations
// through at once (the same reason usage-job.ts guards its setup).
type Waiter = { settle: (granted: boolean) => void }
type JeffQueue = { busy: boolean; waiting: Waiter[] }

declare global {
  var __rialtoJeffQueue: JeffQueue | undefined
}

function queueState(): JeffQueue {
  if (globalThis.__rialtoJeffQueue === undefined) globalThis.__rialtoJeffQueue = { busy: false, waiting: [] }
  return globalThis.__rialtoJeffQueue
}

/** Resolves true once this caller holds the slot, false if the line is full or the wait ran out. */
function acquireSlot(maxWaitMs: number): Promise<boolean> {
  const state = queueState()
  if (!state.busy) {
    state.busy = true
    return Promise.resolve(true)
  }
  if (state.waiting.length >= MAX_QUEUED) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const waiter: Waiter = {
      settle: (granted) => {
        clearTimeout(timer)
        resolve(granted)
      }
    }
    const timer = setTimeout(() => {
      // Leave the line so an abandoned request never takes a turn it cannot use.
      const index = state.waiting.indexOf(waiter)
      if (index !== -1) state.waiting.splice(index, 1)
      waiter.settle(false)
    }, maxWaitMs)
    state.waiting.push(waiter)
  })
}

function releaseSlot(): void {
  const state = queueState()
  const next = state.waiting.shift()
  if (next === undefined) {
    state.busy = false
    return
  }
  // Hand the slot straight to the next in line; `busy` stays true so nobody can slip in between.
  next.settle(true)
}

/** Test helper: drop every waiter and free the slot, so one failing test cannot wedge the rest. */
export function __resetJeffQueueForTest(): void {
  const state = queueState()
  for (const waiter of state.waiting.splice(0)) waiter.settle(false)
  state.busy = false
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function endpoint(path: '/health' | '/v1/systemone'): URL | null {
  // Only the server operator may select the upstream. Never read a URL from
  // the request, even when a question contains a field that resembles one.
  const base = process.env.JEFF_URL?.trim()
  if (base === undefined || base.length === 0) return null
  try {
    const url = new URL(base)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      return null
    return new URL(path, url)
  } catch {
    return null
  }
}

function headers(): Headers {
  const result = new Headers({ Accept: 'application/json', 'Content-Type': 'application/json' })
  const key = process.env.JEFF_API_KEY?.trim()
  if (key !== undefined && key.length > 0) result.set('Authorization', `Bearer ${key}`)
  return result
}

export async function getJeffStatus(): Promise<{
  configured: boolean
  ready: boolean
  shadowEnabled: boolean
  model: string | null
  error: string | null
}> {
  const configured = process.env.JEFF_URL?.trim()
  const shadowEnabled = process.env.JEFF_SHADOW_ENABLED === 'true'
  if (configured === undefined || configured.length === 0) {
    return { configured: false, ready: false, shadowEnabled, model: null, error: null }
  }
  const url = endpoint('/health')
  if (url === null) return { configured: true, ready: false, shadowEnabled, model: null, error: 'Jeff URL is invalid.' }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), redirect: 'error' })
    if (!response.ok)
      return {
        configured: true,
        ready: false,
        shadowEnabled,
        model: null,
        error: `Jeff returned HTTP ${response.status}.`
      }
    const parsed = z
      .object({ status: z.enum(['ready', 'loading']), model: z.string().nonempty() })
      .safeParse(await response.json())
    if (!parsed.success)
      return {
        configured: true,
        ready: false,
        shadowEnabled,
        model: null,
        error: 'Jeff returned an invalid health response.'
      }
    return {
      configured: true,
      ready: parsed.data.status === 'ready',
      shadowEnabled,
      model: parsed.data.model,
      error: null
    }
  } catch {
    return { configured: true, ready: false, shadowEnabled, model: null, error: 'Jeff is unavailable or timed out.' }
  }
}

export interface EvaluationOptions {
  /** Per-attempt budget, counted once the evaluation has its turn. */
  timeoutMs?: number
  /** Longest the caller waits for its turn and for a 529 back-off. */
  maxWaitMs?: number
}

type Evaluation = { ok: true; data: DecisionEvaluateResponse } | { ok: false; error: string }
// `retryAfterMs` is set only for a 529: Jeff is still busy with something that did
// not come through this queue (another Rialto, or a direct caller).
type Attempt = { result: Evaluation; retryAfterMs: number | null }

const retryAfterMs = (response: Response): number => {
  const header = response.headers.get('retry-after')
  return header !== null && /^\d{1,3}$/.test(header.trim()) ? Number(header) * 1000 : DEFAULT_RETRY_AFTER_MS
}

async function attempt(url: URL, request: DecisionEvaluateRequest, timeoutMs: number): Promise<Attempt> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error'
    })
    if (response.status === 529) {
      return { result: { ok: false, error: 'Jeff returned HTTP 529.' }, retryAfterMs: retryAfterMs(response) }
    }
    if (!response.ok)
      return { result: { ok: false, error: `Jeff returned HTTP ${response.status}.` }, retryAfterMs: null }
    const parsed = DecisionEvaluateResponseSchema.safeParse(await response.json())
    if (!parsed.success)
      return { result: { ok: false, error: 'Jeff returned an invalid response.' }, retryAfterMs: null }
    return { result: { ok: true, data: parsed.data }, retryAfterMs: null }
  } catch {
    return { result: { ok: false, error: 'Jeff is unavailable or timed out.' }, retryAfterMs: null }
  }
}

export async function evaluateWithJeff(
  request: DecisionEvaluateRequest,
  { timeoutMs = EVALUATION_TIMEOUT_MS, maxWaitMs = DEFAULT_MAX_WAIT_MS }: EvaluationOptions = {}
): Promise<Evaluation> {
  const url = endpoint('/v1/systemone')
  if (url === null) return { ok: false, error: 'Jeff URL is invalid.' }
  const deadline = dayjs().valueOf() + maxWaitMs
  if (!(await acquireSlot(maxWaitMs))) return { ok: false, error: BUSY_ERROR }
  try {
    const first = await attempt(url, request, timeoutMs)
    if (first.retryAfterMs === null) return first.result
    // One retry, only if Jeff's own Retry-After fits in what is left of the wait.
    // The slot is kept meanwhile so queued callers do not overtake this one.
    if (first.retryAfterMs > deadline - dayjs().valueOf()) return first.result
    await sleep(first.retryAfterMs)
    return (await attempt(url, request, timeoutMs)).result
  } finally {
    // Always, or one failure would block every later evaluation.
    releaseSlot()
  }
}
