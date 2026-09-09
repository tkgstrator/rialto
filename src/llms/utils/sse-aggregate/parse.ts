/**
 * The only thing the four aggregators share: SSE framing.
 *
 * Each aggregator understands one vendor's event vocabulary and nothing
 * else, so this is where the split bottoms out — everything above it is
 * per-wire-format and independent.
 */

// Split an SSE payload into event records. Each event may carry an
// `event:` label plus one or more `data:` lines. We only care about the
// JSON on the `data:` lines — the `type` field on the JSON payload is
// authoritative, so the `event:` label is redundant.
export function* parseSseEvents(raw: string): Generator<unknown> {
  for (const chunk of raw.split(/\r?\n\r?\n/)) {
    if (chunk.length === 0) continue
    const dataLines = chunk
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
    if (dataLines.length === 0) continue
    const joined = dataLines.join('\n')
    if (joined === '' || joined === '[DONE]') continue
    try {
      yield JSON.parse(joined)
    } catch {
      // dropped: malformed event
    }
  }
}

export function isSseContentType(contentType: string | null): boolean {
  return contentType?.toLowerCase().includes('text/event-stream') === true
}

/**
 * Why an SSE body cannot be folded into a usable envelope.
 *
 * The aggregators are deliberately forgiving — "a partial reconstruction
 * beats a 500" — and that is right when a stream is merely cut short:
 * `message_start` arrived, so the client still gets a well-formed
 * envelope carrying whatever text made it. It is wrong when nothing
 * usable arrived at all. The fold then returns a husk (`{"content":[]}`
 * for anthropic) and relaying that under the upstream's 200 launders a
 * failed request into a successful-looking one — the caller's SDK sees a
 * malformed success it cannot retry, and the operator sees nothing.
 *
 * Detection lives here, beside the framing, because this is the only
 * part that genuinely is shared: all four wire formats signal a
 * mid-stream failure with a top-level `error` object, and "no foldable
 * events at all" needs no vocabulary whatsoever.
 */
export type SseStreamDefect = { reason: 'no-events' } | { reason: 'upstream-error'; status: number; body: unknown }

function isErrorEvent(event: unknown): event is object {
  if (event === null || typeof event !== 'object') return false
  // Anthropic names it on `type`; OpenAI and Google only carry the
  // object. No successful event in any of the four vocabularies has a
  // top-level `error`, so this cannot false-positive on a good stream.
  if (Reflect.get(event, 'type') === 'error') return true
  const error = Reflect.get(event, 'error')
  return error !== null && typeof error === 'object'
}

// Recover the HTTP status the upstream would have sent had it failed
// before opening the stream. Google puts it on `error.code` outright;
// Anthropic and OpenAI only classify on `error.type`, so this mirrors
// the status→type tables in `api/v1/error-shape.ts` in reverse and a
// round trip through both lands where it started. 502 is the honest
// default: the upstream failed and did not say how.
function statusForErrorEvent(event: object): number {
  const error = Reflect.get(event, 'error')
  if (error === null || typeof error !== 'object') return 502
  const code = Reflect.get(error, 'code')
  if (typeof code === 'number' && code >= 400 && code <= 599) return code
  const type = Reflect.get(error, 'type')
  if (type === 'invalid_request_error') return 400
  if (type === 'authentication_error') return 401
  if (type === 'permission_error') return 403
  if (type === 'not_found_error') return 404
  if (type === 'rate_limit_error') return 429
  // Anthropic's capacity signal, and the reason it is worth separating
  // from a bare 502: clients back off and retry on 529, which is the
  // correct response to an overloaded upstream.
  if (type === 'overloaded_error') return 529
  return 502
}

/**
 * Inspect an SSE body before folding it. Returns null when the stream is
 * good enough to aggregate — including the merely-truncated case the
 * aggregators already handle well.
 *
 * Parses the body a second time (the aggregator parses it again to fold
 * it). That is a few hundred microseconds on the non-stream path only,
 * and the alternative — threading a defect channel out of all four
 * aggregators — would spread this one concern across every wire format.
 */
export function findSseStreamDefect(raw: string): SseStreamDefect | null {
  const events = [...parseSseEvents(raw)]
  const failure = events.find(isErrorEvent)
  if (failure !== undefined) return { reason: 'upstream-error', status: statusForErrorEvent(failure), body: failure }
  if (events.length === 0) return { reason: 'no-events' }
  return null
}
