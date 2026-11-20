/**
 * Model discovery for a custom provider: ask the operator's own endpoint
 * what it serves.
 *
 * There is no vendor adapter behind a custom provider, so this is the whole
 * of its catalog story. Connect can fall back to manual entry, while Refresh
 * needs a complete listing before it can reconcile the stored models.
 */

import { type CustomApiStyle, customModelsUrls } from '@/shared/custom-provider'
import { VendorModelsResponseSchema } from '../schemas/api/models'
import { buildAuthedRequest, extractContextWindows, extractModelIds } from './base'

type CustomModelsPage = {
  ok: true
  ids: string[]
  contextWindows?: Map<string, number>
  next?: string
}
export type CustomModelsResult = Omit<CustomModelsPage, 'next'> | { ok: false; error: string }

// A local server that is down hangs rather than refuses; the Connect form is
// waiting on this, so it gives up quickly and offers manual entry instead.
const FETCH_TIMEOUT_MS = 8_000

type CustomModelsInput = {
  baseUrl: string
  apiKey: string
  style: CustomApiStyle
}

// One candidate URL. Redirects are not followed: `x-api-key` is not one of
// the headers a fetch strips when a redirect leaves the origin, so following
// one would hand the key to wherever the server points. The operator is told
// where it points and can store that address instead.
const tryUrl = async (
  url: string,
  input: CustomModelsInput,
  fetchImpl: typeof fetch,
  complete: boolean
): Promise<CustomModelsPage | { ok: false; error: string }> => {
  const { url: target, headers } = buildAuthedRequest(
    input.style === 'anthropic' ? 'x-api-key' : 'bearer',
    { kind: 'api_key', key: input.apiKey },
    url
  )
  const res = await fetchImpl(target, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  }).catch((err: unknown) => (err instanceof Error ? err : new Error('request failed')))
  if (res instanceof Error) {
    return {
      ok: false,
      error: res.name === 'TimeoutError' ? `${url} did not answer in time` : `${url}: ${res.message}`
    }
  }
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location')
    return {
      ok: false,
      error: location === null ? `${url} redirected` : `${url} redirected to ${location}; use that address instead`
    }
  }
  if (!res.ok) return { ok: false, error: `${url} returned HTTP ${res.status}` }
  const body: unknown = await res.json().catch(() => null)
  return parseModelsPage(url, body, complete)
}

function parseModelsPage(
  url: string,
  body: unknown,
  complete: boolean
): CustomModelsPage | { ok: false; error: string } {
  const parsed = VendorModelsResponseSchema.safeParse(body)
  if (!parsed.success) return { ok: false, error: `${url} returned an unrecognised response shape` }
  const ids = extractModelIds(parsed.data)
  const entries = parsed.data.data === undefined ? parsed.data.models : parsed.data.data
  if (ids === null || (complete && ids.length !== entries?.length))
    return { ok: false, error: `${url} returned an unrecognised response shape` }
  if (!complete && ids.length === 0) return { ok: false, error: `${url} listed no models` }
  const contextWindows = extractContextWindows(parsed.data)
  const cursor = parsed.data.last_id
  if (complete && parsed.data.has_more === true && (typeof cursor !== 'string' || cursor.length === 0)) {
    return { ok: false, error: `${url} indicated more models without a cursor` }
  }
  return {
    ok: true,
    ids: [...new Set(ids)],
    ...(contextWindows.size > 0 ? { contextWindows } : {}),
    ...(complete && parsed.data.has_more === true && typeof cursor === 'string' ? { next: cursor } : {})
  }
}

async function fetchModelListing(
  url: string,
  input: CustomModelsInput,
  fetchImpl: typeof fetch,
  complete: boolean
): Promise<CustomModelsResult> {
  let page = await tryUrl(url, input, fetchImpl, complete)
  if (!page.ok || page.next === undefined) return page

  const ids = new Set<string>()
  const contextWindows = new Map<string, number>()
  const cursors = new Set<string>()
  for (let count = 0; count < 100; count++) {
    if (!page.ok) return page
    for (const id of page.ids) ids.add(id)
    for (const [id, limit] of page.contextWindows === undefined ? [] : page.contextWindows)
      contextWindows.set(id, limit)
    if (page.next === undefined) return { ok: true, ids: [...ids], contextWindows }
    if (cursors.has(page.next)) return { ok: false, error: `${url} did not finish listing models` }
    cursors.add(page.next)
    const next = new URL(url)
    next.searchParams.set('after_id', page.next)
    page = await tryUrl(next.toString(), input, fetchImpl, complete)
  }
  return { ok: false, error: `${url} did not finish listing models` }
}

/**
 * The model ids the endpoint lists, trying `customModelsUrls` in order.
 * The first candidate that yields ids wins. When none does, the error is the
 * first candidate's: it is the address the operator's own Base URL points at,
 * so its status is the one that explains their setup (a 401 there beats the
 * 404 of a guessed sibling path).
 */
export const fetchCustomModels = async (
  input: CustomModelsInput,
  fetchImpl: typeof fetch = fetch,
  { complete = false }: { complete?: boolean } = {}
): Promise<CustomModelsResult> => {
  const urls = customModelsUrls(input.baseUrl, input.style)
  if (urls.length === 0) return { ok: false, error: 'Base URL is not an http(s) address' }
  const failures: string[] = []
  for (const url of urls) {
    const result = await fetchModelListing(url, input, fetchImpl, complete)
    if (result.ok) return result
    failures.push(result.error)
  }
  return { ok: false, error: failures[0] }
}
