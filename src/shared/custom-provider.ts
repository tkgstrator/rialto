/**
 * Pure rules for the "Custom" provider: any endpoint that speaks one of
 * three wire formats, added by hand instead of coming from the vendor
 * catalog.
 *
 * Lives in `shared/` because the Connect form and the server must agree
 * on three things and must not be able to drift: which names are free,
 * which endpoint URL a typed Base URL turns into, and where the model
 * list is looked for. The form previews the result live; the route stores
 * the same string. No Prisma, no Node built-ins — the browser bundles it.
 */

import { SUBSCRIPTION_PRESETS, VENDOR_DEFAULTS } from './data'

/**
 * The wire formats a custom endpoint can be on. `gemini` is left out on
 * purpose: its URL carries the model and its key travels as a query
 * parameter, so a typed Base URL cannot describe it.
 */
export const CUSTOM_API_STYLES = ['anthropic', 'openai_chat', 'openai_responses'] as const
export type CustomApiStyle = (typeof CUSTOM_API_STYLES)[number]

export const isCustomApiStyle = (value: unknown): value is CustomApiStyle =>
  CUSTOM_API_STYLES.some((style) => style === value)

export const CUSTOM_NAME_MAX_LENGTH = 48

// Lowercase slug. The name is a URL segment (`/providers/<name>`), half of
// the `provider,model` id the router parses on the first comma, and the key
// the config file and the credential store use, so nothing that needs
// escaping in any of those is allowed.
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/

// Path segments under /providers that the SPA router owns. A provider
// named like one would be unreachable from its own detail screen.
const ROUTE_SEGMENTS: readonly string[] = ['connect', 'subscriptions', 'api-keys', 'models', 'priorities', 'test']

// `custom` is the rail entry's own id; `gemini-cli` is reserved for the
// subscription vendor the rail already draws a card for.
const RESERVED_WORDS: readonly string[] = ['custom', 'gemini-cli']

/** Names the catalog already owns: api_key vendors and subscription presets. */
export const isBuiltInVendorName = (name: string): boolean =>
  Object.hasOwn(VENDOR_DEFAULTS, name) || SUBSCRIPTION_PRESETS.some((preset) => preset.id === name)

export type CustomNameProblem = 'empty' | 'too_long' | 'charset' | 'reserved'

/**
 * Why a name cannot be used, or null when it can. Uniqueness against the
 * rows that already exist is the server's check; this is everything that
 * can be said about the string alone.
 */
export const customNameProblem = (raw: string): CustomNameProblem | null => {
  const name = raw.trim()
  if (name === '') return 'empty'
  if (name.length > CUSTOM_NAME_MAX_LENGTH) return 'too_long'
  if (!NAME_PATTERN.test(name)) return 'charset'
  // `claude-code*` is matched by prefix in the style derivation
  // (`apiStyleForVendor`), so a custom `claude-code-proxy` would silently
  // be treated as a subscription vendor.
  if (isBuiltInVendorName(name) || name.startsWith('claude-code')) return 'reserved'
  if (RESERVED_WORDS.includes(name) || ROUTE_SEGMENTS.includes(name)) return 'reserved'
  return null
}

/**
 * Whether a stored provider is a hand-added one: paid by key, and not a
 * vendor the catalog knows. Decided on the name because nothing else marks
 * the row — which also makes a legacy api_key provider carried over under
 * an unknown name count as custom. That is the right reading: such a row
 * has no vendor adapter either, so the model sync and the price jobs must
 * leave it alone for the same reason.
 */
export const isCustomProvider = (name: string, authMode: 'api_key' | 'subscription'): boolean =>
  authMode === 'api_key' && !isBuiltInVendorName(name)

export type CustomBaseUrl = {
  origin: string
  /** Path before the endpoint tail, no trailing slash. Empty for a bare origin. */
  head: string
  /** The operator typed the endpoint itself (`.../chat/completions`). */
  typedTail: boolean
}

const TYPED_TAIL = /\/(?:chat\/completions|responses|messages)$/

/**
 * Split a typed Base URL into the parts the endpoint is built from.
 * Null when it is not an http(s) URL, or when it carries a user, password,
 * query or fragment: those would be stored in the clear in the config and
 * echoed in logs, and the key has a field of its own.
 */
export const parseCustomBaseUrl = (raw: string): CustomBaseUrl | null => {
  const text = raw.trim()
  if (text === '') return null
  // `new URL` throws on garbage; canParse keeps that out of control flow.
  if (!URL.canParse(text)) return null
  const parsed = new URL(text)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.hostname === '') return null
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') return null
  const path = parsed.pathname.replace(/\/+$/, '')
  const typedTail = TYPED_TAIL.test(path)
  return { origin: parsed.origin, head: typedTail ? path.replace(TYPED_TAIL, '') : path, typedTail }
}

const OPENAI_TAIL: Record<'openai_chat' | 'openai_responses', string> = {
  openai_chat: '/chat/completions',
  openai_responses: '/responses'
}

// The path every endpoint of this provider hangs off — `/v1` for a bare
// origin, because that is where OpenAI-compatible servers (LM Studio,
// Ollama, vLLM, the hosted ones) serve. An operator whose server serves at
// the root types the endpoint itself, and that is taken literally.
const apiPrefix = (base: CustomBaseUrl, style: CustomApiStyle): string => {
  if (base.typedTail) return base.head
  if (style === 'anthropic') return base.head.endsWith('/v1') ? base.head : `${base.head}/v1`
  return base.head === '' ? '/v1' : base.head
}

/**
 * The full endpoint a request is posted to, which is what
 * `Provider.api_base_url` holds for every built-in vendor too. Null for a
 * Base URL `parseCustomBaseUrl` rejects.
 *
 * The OpenAI tail chosen here is only the provider's default: the send path
 * retargets `/chat/completions` <-> `/responses` per model
 * (`llms/utils/openai-endpoint.ts`), so a per-model override keeps working
 * on a custom provider.
 */
export const customEndpointUrl = (raw: string, style: CustomApiStyle): string | null => {
  const base = parseCustomBaseUrl(raw)
  if (base === null) return null
  const prefix = apiPrefix(base, style)
  const tail = style === 'anthropic' ? '/messages' : OPENAI_TAIL[style]
  return `${base.origin}${prefix}${tail}`
}

/**
 * Where the model list is looked for, in the order to try. The typed path
 * first (`{base}/v1/models` for a bare origin, `{base}/models` for one that
 * already ends in `/v1`), then the sibling spelling for servers that mount
 * the list somewhere other than their chat endpoint: without `/v1` when the
 * base has one, with it when the base has none. `/v1` is never stacked on a
 * base that already ends in it.
 */
export const customModelsUrls = (raw: string, style: CustomApiStyle): string[] => {
  const base = parseCustomBaseUrl(raw)
  if (base === null) return []
  const prefix = apiPrefix(base, style)
  const versioned = base.head.endsWith('/v1')
  const sibling = versioned ? `${base.head.slice(0, -'/v1'.length)}/models` : `${base.head}/v1/models`
  const candidates = [`${prefix}/models`, `${base.head}/models`, sibling]
  return [...new Set(candidates)].map((path) => `${base.origin}${path}`)
}
