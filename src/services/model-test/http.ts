/**
 * Fetch-with-timeout plus vendor error-body parsing shared by every
 * connectivity probe (Anthropic / Gemini / OpenAI-family).
 */

export type ProbeResult = { ok: boolean; error?: string }

const TIMEOUT_MS = 20_000

export const fetchWithTimeout = async (url: string, init: RequestInit): Promise<Response> => {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: ac.signal })
  } finally {
    clearTimeout(timer)
  }
}

// A 400 saying the output budget was exhausted means the model
// actually ran (auth ok, model exists) — it just couldn't finish
// within the deliberately tiny cap the probes send. For a reachability
// test that's a pass; reasoning models spend the budget on hidden
// reasoning and never emit a token.
//
// A bare `max_output_tokens` used to be a third alternative here, which
// was wrong twice over: the Responses API reports an exhausted budget as
// HTTP 200 with `status: "incomplete"`, never a 400, so no legitimate
// rejection carries that word — and matching it turned the
// "integer_below_min_value" error from the probe's own invalid cap of 1
// into a pass. The probe now sends a valid 16 (see probes.ts), so a 400
// naming that field is a real failure and must surface as one.
const budgetExhausted = (s: number, b: string): boolean =>
  s === 400 && /could not finish the message because max_tokens|model output limit was reached/i.test(b)

// A 429 means the credential authenticated and the endpoint is
// reachable — we're just throttled. For a connectivity/auth test
// that's a pass (same intent as budgetExhausted).
export const reachable = (s: number, b: string): boolean => s === 429 || budgetExhausted(s, b)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const readNonEmptyString = (source: Record<string, unknown>, key: string): string | null => {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

// Anthropic nests the message one level deeper:
// { "error": { "message": "..." } }. Return the inner message if that
// shape matches; otherwise null so the caller can try the flat forms.
const extractNestedErrorMessage = (parsed: Record<string, unknown>): string | null => {
  const err = parsed.error
  if (!isRecord(err)) return null
  return readNonEmptyString(err, 'message')
}

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

// Vendor error responses come in three known shapes:
//   - Anthropic:  { "type":"error", "error": { "type":"...", "message":"..." } }
//   - OpenAI:     { "error": { "message":"...", ... } } (also plain string form)
//   - Codex web:  { "detail":"..." }
// Fall through to the raw body when nothing matches so we never lose
// context; the raw text is also what shows up if the body wasn't JSON
// at all (Cloudflare error page, upstream gateway HTML, etc.).
const extractVendorMessage = (body: string): string => {
  const parsed = parseJson(body)
  if (!isRecord(parsed)) return body
  const nested = extractNestedErrorMessage(parsed)
  if (nested !== null) return nested
  const err = readNonEmptyString(parsed, 'error')
  if (err !== null) return err
  const detail = readNonEmptyString(parsed, 'detail')
  if (detail !== null) return detail
  const message = readNonEmptyString(parsed, 'message')
  if (message !== null) return message
  return body
}

// Format an HTTP failure for a ProbeResult. Extracts the vendor's error
// message when the body is JSON, otherwise passes the raw body through.
// Truncated to 200 chars so a giant HTML error page doesn't flood the
// Model row's testError column.
export const formatHttpError = (status: number, body: string): string =>
  `HTTP ${status}: ${extractVendorMessage(body).slice(0, 200)}`
