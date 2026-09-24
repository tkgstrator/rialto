/**
 * In-process record of which providers / sub-accounts are currently
 * rate-limited.
 *
 * Populated reactively when an upstream returns a rate-limit status
 * (429), and consulted by the router so it can skip an exhausted entry
 * until its limit window resets. Both maps are process-local — they
 * reset on restart, which is fine: a fresh process re-probes every
 * provider/account on its next request and re-learns the exhausted set
 * from the first 429. Mirrors the in-memory approach used by
 * session-account-router.
 *
 * Two scopes are tracked separately:
 *   - Provider-level: every account in this provider is over its
 *     ceiling, or the provider has no concept of accounts.
 *   - Account-level (subAccountId): one specific subscription account
 *     hit its 5-hour or weekly window, but peer accounts on the same
 *     provider may still be usable. The router checks the account map
 *     first so it can rotate accounts within the same provider before
 *     giving up on the provider as a whole.
 */

// Default cooldown applied when the caller has no precise reset time
// from the usage API. Subscription limits reset on much longer windows,
// but a short default keeps the router re-probing the primary instead of
// pinning the fallback forever. The proactive path (which knows the real
// resetAt from the usage poll) supplies a precise `until` instead.
const DEFAULT_COOLDOWN_MS = 5 * 60_000

// Build a TTL-keyed exhaustion map. Both the provider-level and the
// account-level marks share the exact same semantics — auto-evict on
// read once the deadline passes, never let a default cooldown shorten a
// more precise expiry — so the storage + behaviour lives in one place
// and the two public APIs are thin named wrappers around it.
const createExhaustionMap = (): {
  mark: (key: string, until?: number) => void
  is: (key: string) => boolean
  clear: (key: string) => void
  liveKeys: () => string[]
} => {
  const map = new Map<string, number>()
  const is = (key: string): boolean => {
    const until = map.get(key)
    if (until === undefined) return false
    if (until <= Date.now()) {
      map.delete(key)
      return false
    }
    return true
  }
  return {
    mark: (key, until) => {
      const now = Date.now()
      const resolved = typeof until === 'number' && until > now ? until : now + DEFAULT_COOLDOWN_MS
      const current = map.get(key)
      if (current === undefined || resolved > current) map.set(key, resolved)
    },
    is,
    clear: (key) => {
      map.delete(key)
    },
    // Every key still inside its window, evicting the expired ones on the
    // way — the same answer `is` would give for each.
    liveKeys: () => [...map.keys()].filter(is)
  }
}

const providerMap = createExhaustionMap()
const accountMap = createExhaustionMap()
const modelMap = createExhaustionMap()

// Model-scoped keys pair a provider with a specific model so two
// different models on the same provider can be exhausted independently.
// The subscription providers Anthropic and OpenAI track their 5-hour /
// weekly windows per-model, so a Fable 429 leaves Opus (on the same
// account) free to serve traffic.
const modelKey = (providerName: string, modelName: string): string => `${providerName}||${modelName}`

// Mark a provider as rate-limited until `until` (epoch millis). When
// `until` is absent or already in the past, fall back to a short
// cooldown. Never shortens an existing, later expiry — a precise resetAt
// shouldn't be clobbered by a subsequent default-cooldown mark.
export const markProviderExhausted = (providerName: string, until?: number): void =>
  providerMap.mark(providerName, until)

// True when the provider is currently within an exhaustion window.
// Expired entries are evicted on read so the next probe goes back to the
// primary automatically.
export const isProviderExhausted = (providerName: string): boolean => providerMap.is(providerName)

// Drop a provider's exhaustion mark (e.g. after a successful response
// proves the window has reset).
export const clearProviderExhaustion = (providerName: string): void => providerMap.clear(providerName)

// Mark a specific subscription account as rate-limited. Account-level
// is finer-grained than provider-level: a single 429 on account A
// redirects peer requests to accounts B/C in the same provider, not the
// entire provider's fallback chain.
export const markAccountExhausted = (subAccountId: string, until?: number): void => accountMap.mark(subAccountId, until)

// True when the account is currently within an exhaustion window.
// Expired entries are evicted on read.
export const isAccountExhausted = (subAccountId: string): boolean => accountMap.is(subAccountId)

// Drop an account's exhaustion mark (e.g. after a successful response
// proves the window has reset, or to clear test state).
export const clearAccountExhaustion = (subAccountId: string): void => accountMap.clear(subAccountId)

// Mark a specific `(provider, model)` pair as rate-limited. Model-level
// is one step finer than provider-level: on subscription providers
// whose 5-hour / weekly windows are per-model (Anthropic Fable vs
// Opus, OpenAI GPT-5.5 vs GPT-5.3-codex), a 429 on one model leaves
// the peer models on the same account free to run.
export const markModelExhausted = (providerName: string, modelName: string, until?: number): void =>
  modelMap.mark(modelKey(providerName, modelName), until)

// True when either the model itself OR its enclosing provider is
// currently within an exhaustion window. The two states OR together so
// a provider-level mark (a coarse "everything on this provider is
// out") still short-circuits every model on it.
export const isModelExhausted = (providerName: string, modelName: string): boolean =>
  modelMap.is(modelKey(providerName, modelName)) || providerMap.is(providerName)

// Drop a model's exhaustion mark. Does not clear the enclosing
// provider's mark — that's a separate concern via
// clearProviderExhaustion.
export const clearModelExhaustion = (providerName: string, modelName: string): void =>
  modelMap.clear(modelKey(providerName, modelName))

// The models on this provider that currently carry their own mark. A
// fresh usage reading clears these one model at a time, against the
// windows that bind for that model: a provider-wide sweep would release
// Fable while its own weekly window is still spent, and the next Fable
// request would walk straight back into the 429.
export const modelMarksFor = (providerName: string): string[] => {
  const prefix = modelKey(providerName, '')
  return modelMap
    .liveKeys()
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
}

// ─── Long-context (context-1m) entitlement ─────────────────────────────

// How long a long-context refusal is trusted before the beta is probed
// again. Unlike a rate-limit window this records an *entitlement* the
// upstream refused, which only changes when the user's plan changes —
// so the TTL is long enough to avoid re-429ing on every request, and
// short enough that a plan upgrade is picked up the next day without a
// restart.
const LONG_CONTEXT_DENIAL_TTL_MS = 24 * 60 * 60_000

const longContextMap = createExhaustionMap()

// Account-scoped keys pair a provider with one sub-account so a plan
// without the long-context entitlement doesn't speak for its peers —
// the same provider can carry a 1M account and a non-1M account.
const longContextKey = (providerName: string, subAccountId: string): string => `${providerName}##${subAccountId}`

const hasAccount = (subAccountId?: string | null): subAccountId is string =>
  typeof subAccountId === 'string' && subAccountId.length > 0

// Record that this provider / sub-account refused the context-1m beta.
// Marked against the account when one is known, otherwise against the
// provider as a whole (the accountless overlay path).
export const markLongContextDenied = (providerName: string, subAccountId?: string | null): void =>
  longContextMap.mark(
    hasAccount(subAccountId) ? longContextKey(providerName, subAccountId) : providerName,
    Date.now() + LONG_CONTEXT_DENIAL_TTL_MS
  )

// True when either this sub-account OR its enclosing provider is known
// to lack the long-context entitlement. The two scopes OR together for
// the same reason isModelExhausted does it: a coarse provider-level
// mark (learned before any account was known) still applies to every
// account under it.
export const isLongContextDenied = (providerName: string, subAccountId?: string | null): boolean =>
  (hasAccount(subAccountId) && longContextMap.is(longContextKey(providerName, subAccountId))) ||
  longContextMap.is(providerName)

// Drop a long-context denial so the beta is probed again on the next
// request (plan upgrade, or to reset state between tests). Clears the
// provider-level mark too when no account is given.
export const clearLongContextDenial = (providerName: string, subAccountId?: string | null): void => {
  if (hasAccount(subAccountId)) longContextMap.clear(longContextKey(providerName, subAccountId))
  else longContextMap.clear(providerName)
}
