/**
 * The ordered list of "provider,model" candidates one request may
 * attempt, in the order it should attempt them.
 *
 * This builds the list; `chain-failover.ts` walks it (and handles the
 * per-provider account rotation that happens inside a single entry).
 */

import { isModelExhausted } from '../../services/failover-state'
import type { RoutePlan } from './route-plan'

const providerNameOf = (modelString: string): string => modelString.split(',')[0]
const modelNameOf = (modelString: string): string => modelString.split(',').slice(1).join(',')

// Ordered list of "provider,model" candidates for this request: the
// resolved primary first, then the rest of the chain. Skips candidates
// currently known to be rate-limited (by model or by provider), but
// never returns empty — if every candidate is exhausted we still try
// them (the window may have reset since we marked it).
//
// The chain is honoured as the operator wrote it. There used to be a
// same-auth_mode gate here that dropped an api_key fallback behind a
// subscription primary, on the theory that a 429 on the "free seat"
// should not silently roll onto per-token billing. It is gone: the
// order of the chain IS the operator's statement of what may follow
// what, and an entry they did not want after a subscription would not
// be in the list. The same-provider gate went earlier for a similar
// reason — exhaustion is tracked per (provider, model), so a different
// model on the same account is a legitimate fallback.
export function buildFailoverChain(plan: RoutePlan): string[] {
  const seen = new Set<string>()
  const ordered = [plan.primaryModel, ...plan.fallbacks].filter((m) => {
    if (seen.has(m)) return false
    seen.add(m)
    return true
  })

  const live = ordered.filter((m) => !isModelExhausted(providerNameOf(m), modelNameOf(m)))
  return live.length > 0 ? live : ordered
}
