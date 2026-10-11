import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CaptureOptions, RequestSpec } from './types'

export function hashKey(method: string, url: string, body: unknown): string {
  const canon = JSON.stringify({ method, url, body: body === undefined ? null : body })
  return createHash('sha256').update(canon).digest('hex').slice(0, 16)
}

export function sanitizeSlug(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Scrub server and provider credentials, preserving all other captured fields. */
export function redactResponseBody(url: string, body: string): string {
  if (!url.endsWith('/api/config')) return body
  try {
    const data: unknown = JSON.parse(body)
    if (!isObject(data)) return body
    if (typeof data.APIKEY === 'string' && data.APIKEY) data.APIKEY = '***REDACTED***'
    if (Array.isArray(data.Providers)) {
      for (const provider of data.Providers) {
        if (isObject(provider) && typeof provider.api_key === 'string' && provider.api_key) {
          provider.api_key = '***REDACTED***'
        }
      }
    }
    return JSON.stringify(data)
  } catch {
    return body
  }
}

export async function capture(spec: RequestSpec, options: CaptureOptions): Promise<'recorded' | 'skipped' | 'failed'> {
  const key = hashKey(spec.method, spec.url, spec.body)
  const dir = join(options.fixturesDir, `${sanitizeSlug(spec.slug)}.${key}`)
  const requestPath = join(dir, 'request.json')
  const responsePath = join(dir, 'response.json')
  const bodyPath = join(dir, 'response.body')
  if (existsSync(requestPath) && existsSync(responsePath) && existsSync(bodyPath) && !options.force) {
    console.log(`skip  ${spec.label}`)
    return 'skipped'
  }

  const init: RequestInit = {
    method: spec.method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': options.apiKey,
      'anthropic-version': '2023-06-01',
      // Bun's streaming gzip decoder chokes on chunked-compressed SSE bodies.
      'Accept-Encoding': 'identity'
    }
  }
  if (spec.body !== undefined) init.body = JSON.stringify(spec.body)

  try {
    const res = await fetch(spec.url, init)
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      headers[k] = v
    })
    const rawBody = await res.text()
    const body = redactResponseBody(spec.url, rawBody)

    mkdirSync(dir, { recursive: true })
    writeFileSync(
      requestPath,
      `${JSON.stringify({ label: spec.label, method: spec.method, url: spec.url, body: spec.body === undefined ? null : spec.body }, null, 2)}\n`
    )
    writeFileSync(
      responsePath,
      `${JSON.stringify({ status: res.status, statusText: res.statusText, headers }, null, 2)}\n`
    )
    writeFileSync(bodyPath, body)
    console.log(
      `ok    ${spec.label} -> ${dir.split('/').slice(-2).join('/')}/ (status=${res.status}, ${body.length} bytes)`
    )
    return 'recorded'
  } catch (error) {
    console.error(`FAIL  ${spec.label}: ${errorMessage(error)}`)
    return 'failed'
  }
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
