/**
 * Process-wide singleton tying together the registries the pipeline
 * needs (transformers, providers, tokenizers, config). Replaces the
 * legacy llms-context.ts shim around the vendor Server constructor.
 *
 * The context is built lazily on first request and rebuilt whenever
 * the DB-backed Providers config changes — call `resetLlmsContext()`
 * after a config mutation to force a fresh build.
 */

import type { Logger } from 'pino'
import type { Provider, ProviderConfigShape } from '@/schemas/domain'
import { logger } from '../logger'
import { loadFullConfig } from '../services/config'
import { disabledSet } from '../services/config/transformer'
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

/** Force a rebuild after DB-backed config (Providers) changes. */
export function resetLlmsContext(): void {
  ctxPromise = null
}

async function buildLlmsContext(): Promise<LlmsContext> {
  const cfg = await loadFullConfig()

  // 1. Only what the operator has switched on is servable. A provider
  //    with `enabled: false`, or a model the Providers screen has turned
  //    off, is left out of both the registry and the `providers` view
  //    the router reads — so neither a chain entry nor a passthrough
  //    `provider,model` can reach it. This is the same predicate
  //    `/v1/models` advertises (`getEnabledModels`), so the menu and the
  //    door agree.
  const servable = servableProviders(cfg.Providers)

  // 2. Subscription overlay — mark subscription providers as servable so
  //    the registry does not skip them for a missing api_key. No
  //    credential is baked in here: the OAuth transformers resolve one
  //    per request, which is what lets a provider's accounts be used in
  //    turn rather than one being frozen into the context at build time.
  //    The transformer chain is not overlaid either: the registry derives
  //    it from api_style + auth_mode in step 5.
  const providersWithAuth = applySubscriptionAuth(servable)

  // 3. ConfigStore — the pipeline reads the persona library and the
  //    active persona, HTTPS_PROXY, etc. The router uses
  //    configService.get('providers') for "provider,model" resolution;
  //    keep that key (lowercase) populated alongside the schema-canonical
  //    capital Providers.
  const config = new ConfigStore({
    ...cfg,
    Providers: providersWithAuth,
    providers: providersWithAuth
  })

  // 4. Transformer registry — instantiate the 6 supported transformers.
  const transformers = new TransformerRegistry(logger)
  transformers.registerMany([
    new AnthropicTransformer(),
    new OpenAITransformer(),
    new OpenAIResponsesTransformer(),
    new GeminiTransformer(),
    new ClaudeCodeOauthTransformer(),
    new CodexOauthTransformer()
  ])

  // 5. Provider registry — derive each provider's transformer chain from
  //    its api_style / auth_mode and resolve it against the freshly-built
  //    transformer registry.
  const providers = new ProviderRegistry(transformers, logger)
  providers.registerFromConfig(toProviderConfigShapes(providersWithAuth))

  // 6. Tokenizer registry — used by the scenario router to count tokens.
  const tokenizers = new TokenizerRegistry(logger)
  await tokenizers.initialize()

  return { config, transformers, providers, tokenizers, log: logger }
}

// Drop disabled providers and, within each, the models switched off.
// `Model.enabled` reaches the wire as the provider's
// `transformer._disabledModels` projection (see compose.ts), which is
// the same list the Providers screen toggles.
function servableProviders(providers: Provider[]): Provider[] {
  return providers
    .filter((p) => p.enabled !== false)
    .map((p) => {
      const disabled = disabledSet(p.transformer)
      if (disabled.size === 0) return p
      return { ...p, models: p.models.filter((m) => !disabled.has(m)) }
    })
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
