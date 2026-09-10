/**
 * Process-wide registry of runtime providers.
 *
 * Built from the `Providers[]` slice of AppConfig at boot. The transformer
 * chain each provider runs is DERIVED here, from `api_style` + `auth_mode`
 * (`shared/transformer-chain.ts`), and resolved against the
 * TransformerRegistry into the array of Transformer instances the pipeline
 * iterates at request time. Nothing in the config selects it: there is no
 * `transformer.use` on the way in, only the resolved instances on the way
 * out.
 */

import type { Logger } from 'pino'
import type { ProviderConfigShape, RuntimeProvider } from '@/schemas/domain/pipeline'
import { modelTransformerChains, transformerChain } from '@/shared/transformer-chain'
import type { Transformer } from '../transformers/base'
import type { TransformerRegistry } from './transformer'

/** Provider shape after the derived chain has been resolved to instances.
 *  Structurally compatible with RuntimeProvider (transformer.use is
 *  Transformer[], a subtype of unknown[]), so the pipeline can pass
 *  these straight into transformer hooks. */
export type ResolvedProvider = Omit<RuntimeProvider, 'transformer'> & {
  transformer?: ResolvedProviderTransformer
}

export type ResolvedProviderTransformer = {
  use?: Transformer[]
  /** Per-model overrides keyed by model id, plus runtime-injected
   *  fields like subscriptionCredentialPath / subscriptionAuth. */
  [modelOrKey: string]: { use?: Transformer[] } | Transformer[] | unknown
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ResolvedProvider>()

  constructor(
    private readonly transformers: TransformerRegistry,
    private readonly logger?: Logger
  ) {}

  registerFromConfig(providers: ProviderConfigShape[]): void {
    for (const config of providers) {
      // ProviderConfigShape requires name/api_base_url/api_key as nonempty
      // strings already; this is a defence-in-depth check for callers that
      // hand us pre-parse-equivalent data. Surface the skip so a missing
      // api_key doesn't silently translate to "provider not found" later
      // in the chain walker — the warn is the loudest signal that the row
      // needs an api_key.
      if (!config.name || !config.api_base_url || !config.api_key) {
        const missing = [
          !config.name && 'name',
          !config.api_base_url && 'api_base_url',
          !config.api_key && 'api_key'
        ].filter((s): s is string => typeof s === 'string')
        this.logger?.warn(
          { provider: config.name, missing },
          `provider '${config.name}' skipped — missing required fields: ${missing.join(', ')}`
        )
        continue
      }
      // Null chain = a subscription vendor this build has no auth
      // transformer for. Registering it would mean calling the upstream
      // with the placeholder key the overlay hands out, so skip instead
      // and say which pair produced no chain.
      const chain = transformerChain(config)
      if (chain === null) {
        this.logger?.warn(
          { provider: config.name, apiStyle: config.api_style, authMode: config.auth_mode },
          `provider '${config.name}' skipped — no transformer chain for ${config.auth_mode}/${config.api_style}`
        )
        continue
      }
      try {
        this.providers.set(config.name, this.resolve(config, chain))
        this.logger?.info(`${config.name} provider registered`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.logger?.error(
          { err: error, provider: config.name },
          `${config.name} provider registered error: ${message}`
        )
      }
    }
  }

  get(name: string): ResolvedProvider | undefined {
    return this.providers.get(name)
  }

  getAll(): ResolvedProvider[] {
    return Array.from(this.providers.values())
  }

  private resolve(config: ProviderConfigShape, chain: string[]): ResolvedProvider {
    const resolved: ResolvedProvider = {
      name: config.name,
      api_base_url: config.api_base_url,
      api_key: config.api_key,
      // ProviderConfigShape.models has a Zod .default([]) so a missing
      // array becomes [] after parse — the schema-typed input may still
      // surface undefined for raw callers (z.input side), hence this
      // explicit normalisation rather than trusting the input.
      models: config.models ? config.models : []
    }
    if (config.modelReasoningEfforts) resolved.modelReasoningEfforts = config.modelReasoningEfforts

    // Carry over the non-chain keys the config side owns — the
    // subscription credential the OAuth base reads off
    // `provider.transformer`. An incoming `use` is dropped rather than
    // merged: it is a stale selection from a build that still configured
    // the chain, and letting it through would leave raw strings where the
    // pipeline expects Transformer instances on providers whose derived
    // chain is empty.
    const { use: _staleUse, ...carriedKeys } = config.transformer ? config.transformer : {}
    const carried: ResolvedProviderTransformer = { ...carriedKeys }
    const perModel = modelTransformerChains(config, config.modelApiStyles)
    for (const [model, names] of Object.entries(perModel)) {
      carried[model] = { use: this.resolveChain(config.name, names) }
    }
    if (chain.length > 0) carried.use = this.resolveChain(config.name, chain)

    if (Object.keys(carried).length === 0) return resolved
    resolved.transformer = carried
    return resolved
  }

  /**
   * Look each derived name up in the transformer registry.
   *
   * A miss is a build error, not a config error — the names come from a
   * closed map in `shared/transformer-chain.ts` and every one of them is
   * registered in `llms/context.ts`. It is logged rather than thrown so
   * one bad entry cannot take the whole boot down.
   */
  private resolveChain(providerName: string, names: string[]): Transformer[] {
    const out: Transformer[] = []
    for (const name of names) {
      const instance = this.transformers.get(name)
      if (instance) {
        out.push(instance)
        continue
      }
      this.logger?.error(
        { provider: providerName, transformer: name },
        `transformer '${name}' is not registered — derived chain for '${providerName}' is incomplete`
      )
    }
    return out
  }
}
