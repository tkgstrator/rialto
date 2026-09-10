/**
 * Pure derivations behind the Providers screens.
 *
 * Kept out of the components so the "what does this provider actually
 * speak" logic — the part an operator reads when a request misbehaves —
 * can be reasoned about (and unit-tested) without React.
 */
import type { CatalogEntry, CatalogModel } from '@/schemas/api/catalog'
import type { RouterConfig } from '@/schemas/domain/router'
import { planCapacityWeight, type SeatKind } from '@/shared/plan-capacity'
import { transformerChain } from '@/shared/transformer-chain'
import type { ApiStyle, Provider, ReasoningEffort, SubscriptionWire, TestStatus, Tier, TransformerWire } from './types'

export type ProviderState = 'off' | 'live' | 'invalid' | 'unknown'

/**
 * How many router bindings would be cleared by deleting this provider.
 *
 * Removing a provider cascades to its models and nulls every RouterSlot
 * that pointed at one, which the server reports only as a warning after
 * the fact. Counting them first is what lets the confirm say how much
 * routing the operator is about to lose.
 */
export function routerBindingsFor(router: RouterConfig | undefined, providerName: string): number {
  if (router === undefined) return 0
  const prefix = `${providerName},`
  const scenarios = [router.default, router.think, router.longContext, router.webSearch, router.image]
  return scenarios
    .flatMap((scenario) => [scenario.agent, scenario.subagent])
    .flatMap((lane) => [lane.primary, ...lane.fallbacks])
    .filter((target) => typeof target === 'string' && target.startsWith(prefix)).length
}

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

/**
 * Bucket a model name into one of the four Claude Code families.
 *
 * A local copy of `tierOf` in `llms/scenario-router/model-selection.ts`
 * rather than an import: that module reaches the Prisma client through
 * its neighbours, and pulling the server tree into the browser bundle to
 * read five string tests is the wrong trade. Precedence matches the
 * router — an explicit manual tier wins, name inference is the fallback —
 * so the column shows the tier the router will actually use.
 */
function inferTier(model: string): Tier | null {
  const lower = model.toLowerCase()
  if (lower.includes('fable')) return 'fable'
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('haiku')) return 'haiku'
  return null
}

/** Manual override, name inference, or neither. */
export function tierSourceOf(p: Provider, model: string): TierSource {
  const manual = p.modelManualTiers === undefined ? undefined : p.modelManualTiers[model]
  if (manual !== undefined) return 'manual'
  return inferTier(model) === null ? 'unset' : 'auto'
}

/** Per-model reasoning effort, or null when the vendor default stands. */
export function effortOf(p: Provider, model: string): ReasoningEffort | null {
  const set = p.modelReasoningEfforts === undefined ? undefined : p.modelReasoningEfforts[model]
  return set === undefined ? null : set
}

export function tierOf(p: Provider, model: string): Tier | null {
  const manual = p.modelManualTiers === undefined ? undefined : p.modelManualTiers[model]
  if (manual !== undefined) return manual
  return inferTier(model)
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
 * Mirrors the gate in `services/config/enabled-models.ts` deliberately:
 * a subscription needs an active account with a resolved plan, an
 * api_key provider needs a non-empty key. That gate is applied on top of
 * `Provider.enabled`, so a provider failing it is already unroutable no
 * matter how the switch is set — which is what makes it the right place
 * to lock the switch rather than let an operator set a flag that changes
 * nothing.
 *
 * Not the same question as `providerState() === 'live'`. Live is a
 * verdict on a probe: for an api_key provider it means a model test has
 * *passed*, so a key that works but has never been tested reads
 * `unknown`. Locking on liveness would strand every freshly added key.
 */
export function hasCredential(p: Provider, sub: SubscriptionWire | undefined): boolean {
  if (p.auth_mode === 'subscription') {
    if (sub === undefined || sub.activeAccount === null) return false
    return sub.activeAccount.plan !== null
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

/** `claude_max` / `codex_pro` carry a vendor prefix nobody needs to read. */
export const formatPlan = (plan: string): string => plan.replace(/^(claude|codex)_/i, '')

export function planOf(sub: SubscriptionWire | undefined): string | null {
  if (sub === undefined) return null
  const withPlan = sub.accounts.find((a) => a.plan !== null)
  if (withPlan === undefined || withPlan.plan === null) return null
  return formatPlan(withPlan.plan)
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

/**
 * Context window, in the mock's `400k` / `1M` shorthand.
 *
 * `lib/models/format-context.ts` renders an uppercase `200K`; the Rialto
 * tables use lowercase so the column reads as a magnitude rather than as
 * a unit symbol.
 */
export function fmtContext(n: number | undefined): string {
  if (n === undefined || n <= 0) return '—'
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : parseFloat(m.toFixed(2))}M`
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

export type TierSource = 'manual' | 'auto' | 'unset'

export interface ModelRow {
  name: string
  tier: Tier | null
  /**
   * Where the tier came from. The pill could not say, and the difference
   * decides whether Routing's tier floor can hold this target at all:
   * inference only recognises the four Claude families, so a gpt-* or
   * gemini-* model has no tier until an operator sets one.
   */
  tierSource: TierSource
  /** Model.reasoningEffort. Null means "send nothing, let the vendor pick". */
  effort: ReasoningEffort | null
  contextWindow: number | undefined
  inputPer1M: number | null
  cachedInputPer1M: number | null
  outputPer1M: number | null
  apiStyleOverride: ApiStyle | null
  test: TestStatus
  enabled: boolean
  legacy: boolean
}

const catalogModelIndex = (entry: CatalogEntry | undefined): Map<string, CatalogModel> =>
  new Map(entry === undefined ? [] : entry.models.map((m) => [m.name, m]))

/**
 * One row per listed model.
 *
 * Prices come from the provider row (DB-held, scraped or backfilled) with
 * one exception: the cached-input leg is not mirrored onto Provider, so it
 * is read from the vendor catalog entry. Absent on both sides means the
 * vendor publishes no price, which the table shows as a dash.
 */
export function buildModelRows(p: Provider, catalogEntry: CatalogEntry | undefined): ModelRow[] {
  const off = new Set(disabledModelsOf(p))
  const ctx = p.modelContextWindows === undefined ? {} : p.modelContextWindows
  const prices = p.modelPrices === undefined ? {} : p.modelPrices
  const catalogModels = catalogModelIndex(catalogEntry)
  return listedModelsOf(p).map((name) => {
    const price = prices[name]
    const fromCatalog = catalogModels.get(name)
    return {
      name,
      tier: tierOf(p, name),
      tierSource: tierSourceOf(p, name),
      effort: effortOf(p, name),
      contextWindow: ctx[name],
      inputPer1M: price === undefined ? null : price.inputPer1M,
      cachedInputPer1M: fromCatalog === undefined ? null : fromCatalog.cachedInputPer1M,
      outputPer1M: price === undefined ? null : price.outputPer1M,
      apiStyleOverride: apiStyleOverrideOf(p, name),
      test: testStatusOf(p, name),
      enabled: !off.has(name),
      legacy: fromCatalog === undefined ? false : fromCatalog.legacy
    }
  })
}

/**
 * Which slice of a long model list to show. The default is 'enabled' —
 * on an 18-model vendor the five that are switched on are what the
 * provider actually serves, and the other thirteen are decisions the
 * operator has already made. 'priced' widens to what could be switched
 * on; 'all' is the only one that reveals legacy rows.
 */
export type ShowMode = 'priced' | 'enabled' | 'all'

/**
 * A legacy row worth folding away.
 *
 * Legacy models are still priced, so "Enabled + priced" kept every one of
 * them — rows of vendor history above the models anyone actually routes
 * to, and a decision the operator already made.
 *
 * Unless one is switched on. A legacy model that is enabled is a live
 * routing target, and a list that hides a live target cannot be trusted
 * to say what this provider serves.
 */
export const hidesAsLegacy = (row: ModelRow): boolean => row.legacy && !row.enabled

/** The api_key side's Show control. Legacy rows survive only under "all". */
export const passesShow = (row: ModelRow, mode: ShowMode): boolean => {
  if (mode === 'all') return true
  if (hidesAsLegacy(row)) return false
  if (mode === 'enabled') return row.enabled
  return row.enabled || row.inputPer1M !== null || row.outputPer1M !== null
}

export interface AccountQuota {
  /** '5h' or '7d' — the window the percentage and reset belong to. */
  window: string
  /**
   * The per-model weekly rows carry the model's name here; an account's
   * own window carries null. Both arrive as '7d', so this is the only
   * thing that tells "the account's weekly ceiling" from "Fable's share
   * of it".
   */
  scope: string | null
  pct: number
  resetAt: string | null
}

export type QuotaIndex = Map<string, AccountQuota[]>

/**
 * Every window one account is under, shortest first.
 *
 * The panel used to show one — the weekly, because it is the one an
 * operator plans around — and label it "weekly". All of them bind: an
 * account at 0% for the week is still unroutable while its 5-hour window
 * is spent, and the per-model row is the only place a Fable ceiling is
 * visible at all. Showing one made the other two look like they did not
 * exist.
 *
 * Ordered rather than left as the collector emitted it: 5h, then the
 * account's own 7d, then the per-model rows under it. `windowRank` keeps
 * a scoped '7d' behind the account-wide one it is a share of.
 */
const windowRank = (row: AccountQuota): number => {
  if (row.window === '5h') return 0
  return row.scope === null ? 1 : 2
}

export function quotaForAccount(index: QuotaIndex, accountId: string): AccountQuota[] {
  const mine = index.get(accountId)
  if (mine === undefined) return []
  return [...mine].sort((a, b) => {
    const byRank = windowRank(a) - windowRank(b)
    if (byRank !== 0) return byRank
    // Two per-model rows: alphabetical, so the list does not reshuffle
    // between polls.
    return (a.scope === null ? '' : a.scope).localeCompare(b.scope === null ? '' : b.scope)
  })
}

export function indexQuota(
  rows: ReadonlyArray<{ subAccountId: string; windows: readonly AccountQuota[] }>
): QuotaIndex {
  const out: QuotaIndex = new Map()
  // Flattened back out and re-grouped per account: the accounts panel
  // draws every window an account is under, and `providerQuotaPct` folds
  // the same rows into the rail's single number.
  for (const account of rows) {
    for (const row of account.windows) {
      const bucket = out.get(account.subAccountId)
      const entry = { window: row.window, scope: row.scope, pct: row.pct, resetAt: row.resetAt }
      if (bucket === undefined) out.set(account.subAccountId, [entry])
      else bucket.push(entry)
    }
  }
  return out
}

/** '5h', or '7d' / '7d:fable' — one window across every account. */
const windowKey = (row: AccountQuota): string => (row.scope === null ? row.window : `${row.window}:${row.scope}`)

/** What the aggregate needs off an account: which quota rows, and how big a seat. */
export interface QuotaAccount {
  id: string
  plan: string | null
  rateLimitTier: string | null
}

/**
 * Rail-level headroom for a provider, over every account it owns.
 *
 * Combined per window, then the fullest window wins. Not the worst
 * account: accounts fail over to one another, so a provider holding one
 * exhausted account and one untouched one still has budget left, and
 * reporting 100% there calls a healthy provider dead. Windows stay
 * separate from each other because they reset on different clocks — a 5h
 * burst averaged into the week hides both.
 *
 * Seats are weighted by `planCapacityWeight`, the same 1 / 5 / 20 the
 * routing scheduler weights its own pool budget by, because a percentage
 * is a ratio and ratios over different denominators do not average. A
 * spent Max 5x beside a fresh Max 20x is 20% of the pool gone, not half
 * of it — and the column has to agree with the scheduler that is about to
 * route on the same numbers. `kind` rides along because a plan called
 * "pro" is the unit on Claude and a Max-class seat on Codex.
 */
export function providerQuotaPct(index: QuotaIndex, kind: SeatKind, accounts: readonly QuotaAccount[]): number | null {
  const byWindow = new Map<string, { used: number; weight: number }>()
  for (const account of accounts) {
    const rows = index.get(account.id)
    if (rows === undefined) continue
    const weight = planCapacityWeight(kind, account.plan, account.rateLimitTier)
    for (const row of rows) {
      const key = windowKey(row)
      const prev = byWindow.get(key)
      const seat = { used: row.pct * weight, weight }
      if (prev === undefined) byWindow.set(key, seat)
      else byWindow.set(key, { used: prev.used + seat.used, weight: prev.weight + seat.weight })
    }
  }
  // Only the accounts that reported a window are folded into it: an
  // account the collector has not reached yet is unknown, not empty.
  const pcts = [...byWindow.values()].map((w) => Math.round(w.used / w.weight))
  return pcts.length === 0 ? null : Math.max(...pcts)
}
