/**
 * Proactive failover: exhaustion-mark guard + capability gate.
 *
 * Before sending, `applyProactiveFailover` walks [primary, ...fallbacks]
 * for the scenario and returns the first candidate whose provider is not
 * marked exhausted (by the reactive 429 path) AND whose model can hold
 * the request. Subscription providers are otherwise allowed to run to
 * their upstream limit — the reactive 429 handler in the v1 route walks
 * the same chain and rotates on the observed failure.
 */

import type { Logger } from 'pino'
import type { ScenarioType } from '@/schemas/domain/scenario'
import { isModelExhausted, isProviderExhausted } from '../../services/failover-state'
import type { ConfigStore } from '../registry/config'
import type { ConfigProvider } from './types'

// Provider shape the kind sniffer needs. Re-exported with the helper so
// callers in the route layer can build the same minimal ConfigProvider
// view from the live ConfigStore without depending on the full schema.
export type SubscriptionKindProvider = ConfigProvider

// Map a provider name to the subscription usage "kind" whose limit the
// reactive path will attribute a 429 to, or null for api_key /
// non-subscription providers. Mirrors the apiBaseUrl matching in
// subscription-account-sync-service. Exported so the reactive 429 path in
// the v1 route can use the same classification when rotating accounts
// within a subscription provider.
export function subscriptionKindOf(providerName: string, providers: ConfigProvider[]): 'claude' | 'codex' | null {
  const p = providers.find((x) => x.name === providerName)
  if (p?.auth_mode !== 'subscription') return null
  const url = typeof p.api_base_url === 'string' ? p.api_base_url : ''
  if (url.includes('anthropic.com')) return 'claude'
  if (url.includes('chatgpt.com') || url.includes('openai.com/v1')) return 'codex'
  return null
}

// Whether a single "provider,model" chain candidate is usable right
// now. Providers or specific models already marked exhausted by the
// reactive 429 path are skipped; everything else is allowed through —
// subscription usage is run to the upstream limit and rotated
// reactively on 429 rather than being pre-empted by a local drain
// guard. Exported for unit tests.
//
// Two overloads live behind the same name: `candidateUsable('anthropic')`
// checks provider-level only (legacy), while
// `candidateUsable('anthropic', 'claude-fable')` also honours a
// per-model mark so an intra-provider fallback (Fable → Opus on the
// same account) can still reach the peer model.
export function candidateUsable(providerName: string, modelName?: string): boolean {
  return modelName === undefined ? !isProviderExhausted(providerName) : !isModelExhausted(providerName, modelName)
}

// Capability gate: whether a "provider,model" candidate's model can hold
// a request of `tokenCount` tokens. When the provider declares a context
// window for that model AND the request exceeds it, the candidate is
// rejected (failover must never land on a model that cannot fit the
// request). When the model has no declared window the gate allows it —
// unknown window = allow, which is the conservative default that keeps
// pre-capability-gate behaviour intact.
function candidateFitsContext(candidate: string, tokenCount: number, providers: ConfigProvider[]): boolean {
  const [providerName, modelName] = candidate.split(',')
  if (!providerName || !modelName) return true
  const provider = providers.find((x) => x.name === providerName)
  const windows = provider?.modelContextWindows
  if (!windows) return true
  const limit = windows[modelName]
  if (typeof limit !== 'number') return true
  return tokenCount <= limit
}

/**
 * Proactive failover: before sending, walk [primary, ...fallbacks] and
 * return the first candidate whose provider is not exhausted AND whose
 * model can hold the request. When every candidate looks unusable (or
 * cannot fit) we keep the primary and let the upstream / reactive 429
 * path take over.
 *
 * `fallbacks` is the rest of the chain the selector resolved, after the
 * primary. `scenarioType` is retained for log observability only.
 *
 * Exported for unit tests so the exhaustion mark and capability gate
 * can be exercised directly with a seeded state and ConfigStore.
 */
export function applyProactiveFailover(
  primaryModel: string,
  scenarioType: ScenarioType,
  fallbacks: readonly string[],
  tokenCount: number,
  config: ConfigStore,
  log: Logger
): string {
  if (fallbacks.length === 0) return primaryModel

  const providers = config.get<ConfigProvider[]>('providers', [])

  // Observability: record each candidate the walker considered and why
  // it was rejected so the debug log captures the full chain decision.
  // Emitted only when the primary is dropped — keeping the primary is
  // the common path and would spam the log otherwise.
  const trace: { candidate: string; reason: 'kept' | 'malformed' | 'exhausted' | 'capability' }[] = []
  for (const candidate of [primaryModel, ...fallbacks]) {
    const [providerName, ...rest] = candidate.split(',')
    const modelName = rest.join(',')
    if (!providerName || modelName.length === 0) {
      trace.push({ candidate, reason: 'malformed' })
      continue
    }
    // Per-model check: a Fable 429 only blocks Fable, so an Opus-on-
    // the-same-provider fallback stays reachable. The check ORs in the
    // coarser provider-level mark so a provider that was blanket-
    // exhausted (rare, but the reactive path used to do this) still
    // shorts every model on it.
    if (!candidateUsable(providerName, modelName)) {
      trace.push({ candidate, reason: 'exhausted' })
      continue
    }
    // Capability gate: never fail over onto a model that cannot fit the
    // request — its window would 400 upstream. The primary is gated too
    // so a too-small primary is skipped in favour of a fitting fallback.
    if (!candidateFitsContext(candidate, tokenCount, providers)) {
      trace.push({ candidate, reason: 'capability' })
      continue
    }
    trace.push({ candidate, reason: 'kept' })
    if (candidate !== primaryModel) {
      log.info(
        { from: primaryModel, to: candidate, scenario: scenarioType, tokenCount, trace },
        'proactive failover: primary dropped, using fallback'
      )
    }
    return candidate
  }

  // Every candidate (primary + fallbacks) was rejected. Keep the
  // primary and let the upstream / reactive 429 path take over, but
  // surface the dead chain so the operator can see what was tried.
  log.warn(
    { primary: primaryModel, scenario: scenarioType, tokenCount, trace },
    'proactive failover: all candidates rejected, keeping primary'
  )
  return primaryModel
}
