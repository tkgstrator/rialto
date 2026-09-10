/**
 * Mark subscription Providers as servable so the pipeline does not skip
 * them for a missing api_key.
 *
 * Why this exists: subscription providers store no static api_key — the
 * real bearer token lives on a `SubAccount` row and is injected at
 * request time by a `*-oauth` transformer. The provider registry skips
 * any provider with a falsy api_key, so we hand them a placeholder
 * string here.
 *
 * What this deliberately does NOT do is carry a credential. It used to
 * graft the provider's designated "active" account onto
 * `provider.transformer.subscriptionAuth` at context-build time, which
 * froze one account into a context that is rebuilt only on config
 * change; the OAuth transformers now resolve an account per request
 * (session-account-router), so accounts rotate as their quotas move.
 *
 * Chain selection is NOT done here either. The transformer chain is
 * derived from `Provider.apiStyle` + `Provider.authMode` in
 * `shared/transformer-chain.ts` and built by the registry. This overlay
 * only consults that derivation for one question: whether the provider
 * is servable at all. A subscription vendor this build has no auth
 * transformer for is left untouched, so it stays unregistered rather
 * than being called with a placeholder key.
 */

import type { Provider } from '@/schemas/domain/provider'
import { transformerChain } from '@/shared/transformer-chain'

export const applySubscriptionAuth = (providers: Provider[]): Provider[] =>
  providers.map((p) => {
    if (p.auth_mode !== 'subscription' || p.enabled === false) return p
    if (transformerChain(p) === null) return p
    return { ...p, api_key: 'oauth' }
  })
