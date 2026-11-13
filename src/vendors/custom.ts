/**
 * Model discovery for a custom provider: ask the operator's own endpoint
 * what it serves.
 *
 * There is no vendor adapter behind a custom provider, so this is the whole
 * of its catalog story. It is deliberately a one-shot read at connect time
 * and never part of the model sync: a custom provider has no price sheet and
 * no documented catalog, and the sync must be able to leave it alone. When
 * this finds nothing — a server with no `/models`, a wrong key, a timeout —
 * the Connect flow falls back to model ids typed by hand, so a failure here
 * is a result, not an exception.
 */

import { type CustomApiStyle, customModelsUrls } from '@/shared/custom-provider'
import { VendorModelsResponseSchema } from '../schemas/api/models'
import { buildAuthedRequest, extractModelIds } from './base'

export type CustomModelsResult = { ok: true; ids: string[] } | { ok: false; error: string }

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
const tryUrl = async (url: string, input: CustomModelsInput, fetchImpl: typeof fetch): Promise<CustomModelsResult> => {
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
  const parsed = VendorModelsResponseSchema.safeParse(body)
  if (!parsed.success) return { ok: false, error: `${url} returned an unrecognised response shape` }
  const ids = extractModelIds(parsed.data)
  if (ids === null) return { ok: false, error: `${url} returned an unrecognised response shape` }
  if (ids.length === 0) return { ok: false, error: `${url} listed no models` }
  return { ok: true, ids: [...new Set(ids)] }
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
  fetchImpl: typeof fetch = fetch
): Promise<CustomModelsResult> => {
  const urls = customModelsUrls(input.baseUrl, input.style)
  if (urls.length === 0) return { ok: false, error: 'Base URL is not an http(s) address' }
  const failures: string[] = []
  for (const url of urls) {
    const result = await tryUrl(url, input, fetchImpl)
    if (result.ok) return result
    failures.push(result.error)
  }
  return { ok: false, error: failures[0] }
}
