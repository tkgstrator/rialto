/**
 * Process-wide singleton tying together the registries the pipeline
 * needs (transformers, providers, tokenizers, config). Replaces the
 * legacy llms-context.ts shim around the vendor Server constructor.
 *
 * The context is built lazily on first request and rebuilt whenever
 * the DB-backed Providers / Router config changes — call
 * `resetLlmsContext()` after a config mutation to force a fresh build.
 */

import type { Logger } from 'pino'
import { flattenNestedRouter, type Provider, type ProviderConfigShape } from '@/schemas/domain'
import { logger } from '../logger'
import { loadFullConfig } from '../services/config'
import { applySubscriptionAuth } from '../services/subscription-overlay'
import { ConfigStore } from './registry/config'
import { ProviderRegistry } from './registry/provider'
import { TokenizerRegistry } from './registry/tokenizer'
import { TransformerRegistry } from './registry/transformer'
import { AnthropicTransformer, ClaudeCodeOauthTransformer } from './transformers/anthropic'
import { GeminiTransformer } from './transformers/gemini'
import { CodexOauthTransformer, OpenAIResponsesTransformer, OpenAITransformer } from './transformers/openai'

export type LlmsContext = {
  config: ConfigStore
  transformers: TransformerRegistry
  providers: ProviderRegistry
  tokenizers: TokenizerRegistry
  log: Logger
}

let ctxPromise: Promise<LlmsContext> | null = null

export function getLlmsContext(): Promise<LlmsContext> {
  if (!ctxPromise) ctxPromise = buildLlmsContext()
  return ctxPromise
}

/** Force a rebuild after DB-backed config (Providers / Router) changes. */
export function resetLlmsContext(): void {
  ctxPromise = null
}

async function buildLlmsContext(): Promise<LlmsContext> {
  const cfg = await loadFullConfig()

  // 1. Subscription overlay — mark subscription providers as servable so
  //    the registry does not skip them for a missing api_key. No
  //    credential is baked in here: the OAuth transformers resolve one
  //    per request, which is what lets a provider's accounts be used in
  //    turn rather than one being frozen into the context at build time.
  //    The transformer chain is not overlaid either: the registry derives
  //    it from api_style + auth_mode in step 4.
  const rawProviders: Provider[] = cfg.Providers
  const providersWithAuth = applySubscriptionAuth(rawProviders)

  // 2. ConfigStore — the pipeline reads Router config, scenario thresholds,
  //    HTTPS_PROXY, etc. The router uses configService.get('providers') for
  //    "provider,model" resolution; keep that key (lowercase) populated alongside
  //    the schema-canonical capital Providers.
  // The wire/UI config carries the nested Router shape; the pipeline
  // reads the flat shape (per-kind agent/subagent primary + fallback maps
  // and the two scalar knobs), so flatten it here — the single boundary
  // where nested config crosses into the runtime ConfigStore. Per-project
  // override files are already flat.
  // Resolve the default agent primary's context window so the flat
  // runtime router carries a concrete capacity for the auto-threshold
  // path in classifyScenario. Reads from cfg.Providers rather than the
  // registry so the lookup stays a pure pre-registry step. Null when
  // the primary is unset or the model has no scraped contextWindow.
  const defaultAgentContextWindow = resolveDefaultAgentContextWindow(cfg.Providers, cfg.Router.default.agent.primary)

  const config = new ConfigStore({
    ...cfg,
    Providers: providersWithAuth,
    providers: providersWithAuth,
    Router: flattenNestedRouter(cfg.Router, { defaultAgentContextWindow })
  })

  // 3. Transformer registry — instantiate the 6 supported transformers.
  const transformers = new TransformerRegistry(logger)
  transformers.registerMany([
    new AnthropicTransformer(),
    new OpenAITransformer(),
    new OpenAIResponsesTransformer(),
    new GeminiTransformer(),
    new ClaudeCodeOauthTransformer(),
    new CodexOauthTransformer()
  ])

  // 4. Provider registry — derive each provider's transformer chain from
  //    its api_style / auth_mode and resolve it against the freshly-built
  //    transformer registry.
  const providers = new ProviderRegistry(transformers, logger)
  providers.registerFromConfig(toProviderConfigShapes(providersWithAuth))

  // 5. Tokenizer registry — used by the scenario router to count tokens.
  const tokenizers = new TokenizerRegistry(logger)
  await tokenizers.initialize()

  return { config, transformers, providers, tokenizers, log: logger }
}

/**
 * Bridge Provider[] (the disk/DB shape, with a looser `api_key:
 * string | null`) into the registry input shape ProviderConfigShape[].
 * registerFromConfig defensively skips rows with falsy
 * name/api_base_url/api_key, so the unused-null is runtime-safe.
 *
 * `api_style` / `auth_mode` / `modelApiStyles` come across because the
 * registry derives the transformer chain from them; `transformer` comes
 * across only for the subscription credential keys the overlay grafted on.
 */
function toProviderConfigShapes(providers: Provider[]): ProviderConfigShape[] {
  return providers.map((p) => ({
    name: p.name,
    api_base_url: p.api_base_url,
    // biome-ignore plugin: api_key is nullable on the DB-shaped Provider but the
    // registry filters out null/empty rows in registerFromConfig; the empty-string
    // fallback keeps the type union narrow without a cast.
    api_key: p.api_key ?? '',
    auth_mode: p.auth_mode,
    models: p.models,
    ...(p.api_style ? { api_style: p.api_style } : {}),
    ...(p.modelApiStyles ? { modelApiStyles: p.modelApiStyles } : {}),
    ...(p.transformer ? { transformer: p.transformer } : {}),
    ...(p.modelReasoningEfforts ? { modelReasoningEfforts: p.modelReasoningEfforts } : {})
  }))
}

// Resolve a "provider,model" pointer to its declared contextWindow via
// the provider list. Returns null when the pointer is unset / malformed,
// the provider is unknown, or the vendor never published a window for
// the model. Used by the flat-router assembly above to hand
// classifyScenario a concrete capacity for the auto-threshold path.
function resolveDefaultAgentContextWindow(providers: Provider[], primary: string | null): number | null {
  if (typeof primary !== 'string' || primary === '') return null
  const comma = primary.indexOf(',')
  if (comma <= 0) return null
  const providerName = primary.slice(0, comma)
  const modelName = primary.slice(comma + 1)
  const provider = providers.find((p) => p.name === providerName)
  if (!provider?.modelContextWindows) return null
  const window = provider.modelContextWindows[modelName]
  return typeof window === 'number' && window > 0 ? window : null
}
