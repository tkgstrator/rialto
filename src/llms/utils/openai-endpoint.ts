/**
 * Which OpenAI endpoint a Base URL names, and how to point it at the other.
 *
 * One api_key OpenAI provider hosts models on both wire formats, yet the
 * operator keeps a single Base URL for it. That URL may therefore name either
 * endpoint (`.../chat/completions` or `.../responses`), and each request goes
 * to the endpoint of the wire format its own model resolved to. Swapping the
 * tail at send time is what lets one URL serve both, instead of asking the
 * operator to keep a second one in step.
 *
 * Plain string work on purpose. A URL with a query or fragment has to keep
 * both, a trailing slash has to survive, and a stored value is not
 * guaranteed to parse — a hand-edited config can hold anything — so this
 * does not go through `new URL`.
 */

export type OpenAIEndpoint = 'chat' | 'responses'

const TAIL: Readonly<Record<OpenAIEndpoint, string>> = {
  chat: '/chat/completions',
  responses: '/responses'
}

// Head, one of the two tails, an optional trailing slash, then the query or
// fragment (possibly empty, so every group always matches a string). The
// tail is anchored to the end of the path: a `/responses` in the middle of
// it (`/v1/responses-proxy/x`) is a directory name, not the endpoint. The
// lazy head makes the last tail win when the path somehow holds both.
const NAMED_ENDPOINT = /^([^?#]*?)\/(?:chat\/completions|responses)(\/?)([?#].*|)$/

/**
 * The URL with its endpoint tail swapped for `endpoint`'s. Already pointing
 * there, it comes back unchanged.
 *
 * Null when the URL names neither endpoint (`https://proxy.example/v1/foo`,
 * the Codex backend root). Such a URL has nothing to swap, and what to do
 * with it is the caller's call — the send path leaves it as stored (the
 * Codex auth step appends its own `/responses`), the model probe appends
 * one.
 */
export const retargetOpenAIUrl = (url: string, endpoint: OpenAIEndpoint): string | null => {
  const parts = NAMED_ENDPOINT.exec(url)
  if (parts === null) return null
  const [, head, slash, rest] = parts
  return `${head}${TAIL[endpoint]}${slash}${rest}`
}

/**
 * Where a request must go instead of the stored URL, or null to send it to the
 * stored URL as it is — because that already is the right endpoint, or names
 * none to swap. What the send path wants: a transformer reports a URL only
 * when it changes something, so the unchanged case stays a plain body.
 */
export const redirectedOpenAIUrl = (stored: string, endpoint: OpenAIEndpoint): string | null => {
  const url = retargetOpenAIUrl(stored, endpoint)
  return url === stored ? null : url
}
