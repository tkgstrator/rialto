/**
 * Pure derivations behind the Providers screens.
 *
 * Kept out of the components so the "what does this provider actually
 * speak" logic — the part an operator reads when a request misbehaves —
 * can be reasoned about (and unit-tested) without React.
 */
import { planLabel } from '@/shared/plan-label'
import { hasAuthenticableAccount } from '@/shared/subscription-credential'
import { transformerChain } from '@/shared/transformer-chain'
import type { ApiStyle, Provider, ReasoningEffort, SubscriptionWire, TestStatus, TransformerWire } from './types'

export type ProviderState = 'off' | 'live' | 'invalid' | 'unknown'

/** Models the operator has switched off. Mirrors the DB's Model.enabled. */
export function disabledModelsOf(p: Provider): string[] {
  const raw = p.transformer?._disabledModels
  if (!Array.isArray(raw)) return []
  return raw.filter((m): m is string => typeof m === 'string')
}

/** Deprecated models never reach the table — they cannot be routed to. */
export function listedModelsOf(p: Provider): string[] {
  const dropped = new Set(p.deprecatedModels === undefined ? [] : p.deprecatedModels)
  return p.models.filter((m) => !dropped.has(m))
}

export function enabledCountOf(p: Provider): number {
  const off = new Set(disabledModelsOf(p))
  return listedModelsOf(p).filter((m) => !off.has(m)).length
}

/** Per-model reasoning effort, or null when the vendor default stands. */
export function effortOf(p: Provider, model: string): ReasoningEffort | null {
  const set = p.modelReasoningEfforts === undefined ? undefined : p.modelReasoningEfforts[model]
  return set === undefined ? null : set
}

export function testStatusOf(p: Provider, model: string): TestStatus {
  const entry = p.modelTestStatus === undefined ? undefined : p.modelTestStatus[model]
  return entry === undefined ? 'unknown' : entry.status
}

export function apiStyleOf(p: Provider): ApiStyle | null {
  return p.api_style === undefined ? null : p.api_style
}

/** Per-model request-shape override. Null when the model inherits. */
export function apiStyleOverrideOf(p: Provider, model: string): ApiStyle | null {
  const over = p.modelApiStyles === undefined ? undefined : p.modelApiStyles[model]
  if (over === undefined) return null
  return over === p.api_style ? null : over
}

/**
 * Whether the provider holds something it could authenticate with.
 *
 * Calls the SAME predicate as the gate in
 * `services/config/enabled-models.ts`: a subscription needs at least one
 * account with a resolved plan, an api_key provider needs a non-empty
 * key. That gate is applied on top of `Provider.enabled`, so a provider
 * failing it is already unroutable no matter how the switch is set —
 * which is what makes it the right place to lock the switch rather than
 * let an operator set a flag that changes nothing.
 *
 * Not the same question as `providerState() === 'live'`. Live is a
 * verdict on a probe: for an api_key provider it means a model test has
 * *passed*, so a key that works but has never been tested reads
 * `unknown`. Locking on liveness would strand every freshly added key.
 */
export function hasCredential(p: Provider, sub: SubscriptionWire | undefined): boolean {
  if (p.auth_mode === 'subscription') {
    return sub !== undefined && hasAuthenticableAccount(sub.accounts)
  }
  const key = p.api_key === null ? '' : p.api_key.trim()
  return key.length > 0
}

/**
 * State of the provider as a whole: will it take traffic, and if it may,
 * is its credential good.
 *
 * `off` wins over the health answer because it is the operative one. A
 * switched-off provider is dropped by `enabledTargets` and by
 * `getEnabledModels`, so however live its credential is, nothing routes
 * to it — and reporting `live` there is what let a signed-in Claude Code
 * sit invisible to Routing while this screen called it healthy. The
 * per-account auth status is still on the detail screen, so nothing is
 * lost by leading with the switch.
 *
 * Below that, subscription providers have an authoritative answer — the
 * auth probe result on each SubAccount. api_key providers have none:
 * nothing checks a key until something uses it, so the closest real
 * signal is the last per-model inference test. A provider nobody has
 * tested reads `unknown` rather than being optimistically called live.
 */
export function providerState(p: Provider, sub: SubscriptionWire | undefined): ProviderState {
  if (p.enabled === false) return 'off'
  if (p.auth_mode === 'subscription') {
    if (sub === undefined || sub.accounts.length === 0) return 'unknown'
    if (sub.accounts.some((a) => a.authStatus === 'live')) return 'live'
    if (sub.accounts.some((a) => a.authStatus === 'invalid')) return 'invalid'
    return 'unknown'
  }
  const key = p.api_key === null ? '' : p.api_key.trim()
  if (key.length === 0) return 'unknown'
  const statuses = Object.values(p.modelTestStatus === undefined ? {} : p.modelTestStatus)
  if (statuses.some((s) => s.status === 'ok')) return 'live'
  if (statuses.some((s) => s.status === 'fail')) return 'invalid'
  return 'unknown'
}

/**
 * The provider's plan as the Plan column names it — "Max 20x", "Pro 5x".
 *
 * Read off the first account that reports one. `planLabel` does the
 * naming, because the stored strings (`claude_max`, `prolite`) cannot say
 * on their own which of a vendor's two top plans a seat is on.
 */
export function planOf(sub: SubscriptionWire | undefined): string | null {
  if (sub === undefined) return null
  const withPlan = sub.accounts.find((a) => a.plan !== null || a.rateLimitTier !== null)
  if (withPlan === undefined) return null
  return planLabel(sub.kind === 'other' ? null : sub.kind, withPlan.plan, withPlan.rateLimitTier)
}

/** Most human-readable handle we hold for an account. */
export function accountLabel(a: { userName: string | null; userEmail: string | null; label: string }): string {
  if (a.userName !== null) return a.userName
  if (a.userEmail !== null) return a.userEmail
  return a.label
}

const KEY_BULLETS = '•'.repeat(16)

/**
 * Mask an outbound key for display.
 *
 * `$VAR` / `${VAR}` interpolation placeholders are not secrets — they are
 * the NAME of an environment variable — so they render verbatim. Anything
 * else keeps only the vendor prefix and the last four characters, which
 * is enough to tell two keys apart and not enough to use one.
 */
export function maskKey(key: string): string {
  const { head, bullets, tail } = maskKeyParts(key)
  return `${head}${bullets}${tail}`
}

/**
 * The same mask, split where it is safe to lose characters.
 *
 * A box narrow enough to clip this string clips the END of it, which is
 * the half that identifies the key — "sk-proj-••••••••" says nothing
 * about which of two OpenAI keys is configured. Rendering the three
 * parts separately lets the caller collapse the bullets, which carry no
 * information at all, and keep both ends at any width.
 */
export function maskKeyParts(key: string): { head: string; bullets: string; tail: string } {
  if (key.startsWith('$')) return { head: key, bullets: '', tail: '' }
  if (key.length <= 8) return { head: '', bullets: KEY_BULLETS, tail: '' }
  const dash = key.slice(0, 12).lastIndexOf('-')
  const head = dash > 0 ? key.slice(0, dash + 1) : key.slice(0, 3)
  return { head, bullets: KEY_BULLETS, tail: key.slice(-4) }
}

/** Header the outbound request carries the credential in. */
const API_KEY_AUTH: Record<ApiStyle, string> = {
  anthropic: 'x-api-key',
  gemini: 'x-goog-api-key',
  openai_chat: 'Bearer',
  openai_responses: 'Bearer'
}

/**
 * The transformer chain a request through this provider runs.
 *
 * Imported rather than mirrored: `shared/transformer-chain.ts` is the
 * same pure module the provider registry builds the real chain from, so
 * this block cannot drift from what actually runs — which is the only
 * reason to show it. An empty array covers both "no step needed" (an
 * Anthropic upstream) and "unservable"; the screen renders a dash either
 * way, and an unservable provider already reads as such above.
 */
export function pipelineOf(p: Provider): string[] {
  const chain = transformerChain(p)
  return chain === null ? [] : chain
}

/**
 * The credential an outbound request carries.
 *
 * Returns null for subscription providers rather than a phrase: the
 * api_key answers are header names ('x-api-key', 'Bearer') that are the
 * same in every language, while "subscription (OAuth)" is prose and was
 * reaching the JA build untranslated. The caller supplies that half.
 */
export function authLabelOf(p: Provider): string | null {
  if (p.auth_mode === 'subscription') return null
  const style = apiStyleOf(p)
  return style === null ? '—' : API_KEY_AUTH[style]
}

/**
 * Path the chain's endpoint transformer posts to, read off the live
 * registry rather than hard-coded — the registry is what actually runs.
 */
export function endpointOf(p: Provider, transformers: TransformerWire[]): string | null {
  for (const name of pipelineOf(p)) {
    const found = transformers.find((t) => t.name === name)
    if (found !== undefined && found.endpoint !== null) return found.endpoint
  }
  return null
}

export type { ModelRow, ShowMode } from './model-derive'
export { buildModelRows, fmtContext, hidesAsLegacy, passesShow } from './model-derive'
export type { AccountExtras, AccountExtrasIndex, AccountQuota, QuotaAccount, QuotaIndex } from './quota-derive'
export { fmtExpiry, indexAccountExtras, indexQuota, providerQuotaPct, quotaForAccount } from './quota-derive'
