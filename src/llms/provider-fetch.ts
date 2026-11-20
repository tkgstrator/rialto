/**
 * Thin fetch wrapper used by the pipeline to call the upstream provider.
 * Replaces utils/request.ts. Strict TS, no `any` on the public surface.
 *
 * Bun-friendly:
 *  - Uses AbortController + setTimeout instead of AbortSignal.timeout(),
 *    which throws ERR_INVALID_THIS in Bun when fetch attaches its own
 *    listener to the timeout signal.
 *  - Falls back to a 60-minute soft timeout; the Hono /v1 adapter does
 *    its own idle-timeout clamp at the Bun layer.
 */

import type { Logger } from 'pino'
import { ProxyAgent } from 'undici'

export type ProviderFetchOptions = {
  /** Outgoing request headers. `undefined` values are dropped. */
  headers?: Record<string, string | undefined>
  /** Outbound HTTPS_PROXY. */
  httpsProxy?: string
  /** Caller-supplied abort. The wrapper still adds its own timeout. */
  signal?: AbortSignal
  /** Override the default 60-minute timeout (ms). */
  timeoutMs?: number
}

export type ProviderFetchContext = {
  /** Request id for log correlation; opaque to the wrapper. */
  reqId?: string
}

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000

/** RequestInit augmented with undici's non-standard `dispatcher` slot. */
type RequestInitWithDispatcher = RequestInit & { dispatcher?: unknown }

export async function fetchProvider(
  url: URL | string,
  body: unknown,
  options: ProviderFetchOptions = {},
  context: ProviderFetchContext = {},
  logger?: Logger
): Promise<Response> {
  const multipart = body instanceof FormData
  const headers = new Headers(multipart ? {} : { 'Content-Type': 'application/json' })
  const headerEntries: Array<[string, string | undefined]> = options.headers ? Object.entries(options.headers) : []
  for (const [k, v] of headerEntries) {
    if (v !== undefined && v !== null && v !== 'undefined') headers.set(k, v)
  }

  const controller = new AbortController()
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  options.signal?.addEventListener('abort', () => controller.abort())

  const requestBody = multipart ? body : JSON.stringify(body)
  const init: RequestInitWithDispatcher = {
    method: 'POST',
    headers,
    body: requestBody,
    signal: controller.signal
  }

  // undici ProxyAgent attaches via the non-standard `dispatcher` option,
  // which RequestInit doesn't expose — we use a widened init type instead
  // of an `as` cast at the call site.
  if (options.httpsProxy) {
    init.dispatcher = new ProxyAgent(new URL(options.httpsProxy).toString())
  }

  logger?.debug(
    {
      reqId: context.reqId,
      request: { method: init.method, bodyLength: typeof requestBody === 'string' ? requestBody.length : undefined },
      headers: Object.fromEntries(headers.entries()),
      requestUrl: typeof url === 'string' ? url : url.toString(),
      useProxy: options.httpsProxy
    },
    'final request'
  )

  try {
    return await fetch(typeof url === 'string' ? url : url.toString(), init)
  } finally {
    clearTimeout(timeoutId)
  }
}
