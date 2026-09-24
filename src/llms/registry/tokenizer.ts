/**
 * Tokenizer registry used by the router to estimate request token
 * counts. The tier map's context-window gate compares that count with
 * each route's window, off the cl100k_base tiktoken count — the same
 * heuristic the legacy TokenizerService applied when no per-provider
 * override was set.
 *
 * The registry keeps an eagerly-initialised fallback tokenizer plus a
 * lazy cache of additional ones, in case a future config wants to
 * specify a non-default tokenizer per provider.
 */

import type { Logger } from 'pino'
import type { ProviderTokenizerConfig } from '@/schemas/domain/tokenizer'
import { ApiTokenizer } from '../tokenizers/api'
import type { TokenizeRequest, Tokenizer } from '../tokenizers/base'
import { HuggingFaceTokenizer } from '../tokenizers/huggingface'
import { TiktokenTokenizer } from '../tokenizers/tiktoken'

export type CountTokensResult = {
  tokenCount: number
  tokenizerUsed: string
}

export class TokenizerRegistry {
  private fallback?: Tokenizer
  private readonly cache = new Map<string, Tokenizer>()

  constructor(private readonly logger?: Logger) {}

  async initialize(): Promise<void> {
    const tiktoken = new TiktokenTokenizer('cl100k_base')
    await tiktoken.initialize()
    this.fallback = tiktoken
    this.cache.set('fallback', tiktoken)
    this.logger?.info('TokenizerRegistry initialized (cl100k_base fallback)')
  }

  /**
   * Tokenize a unified request. Without a config the fallback is used;
   * with one, the matching tokenizer is built (and cached) on demand.
   * Errors fall back to tiktoken so router decisions never block on a
   * tokenizer outage.
   */
  async countTokens(request: TokenizeRequest, config?: ProviderTokenizerConfig): Promise<CountTokensResult> {
    const tokenizer = config ? await this.resolve(config) : this.fallback
    if (!tokenizer) throw new Error('TokenizerRegistry.initialize() must run before countTokens')
    const tokenCount = await tokenizer.countTokens(request)
    return { tokenCount, tokenizerUsed: tokenizer.constructor.name }
  }

  private async resolve(config: ProviderTokenizerConfig): Promise<Tokenizer> {
    const key = this.cacheKey(config)
    const cached = this.cache.get(key)
    if (cached) return cached
    try {
      const built = await this.build(config)
      this.cache.set(key, built)
      return built
    } catch (err) {
      this.logger?.error(
        { err, tokenizerType: config.type },
        `Failed to build ${config.type} tokenizer; using fallback`
      )
      if (!this.fallback) throw new Error('TokenizerRegistry.initialize() must run before resolve()')
      return this.fallback
    }
  }

  private async build(config: ProviderTokenizerConfig): Promise<Tokenizer> {
    let tokenizer: Tokenizer
    switch (config.type) {
      case 'tiktoken':
        tokenizer = new TiktokenTokenizer(config)
        break
      case 'huggingface':
        if (!config.model) throw new Error('huggingface tokenizer requires model')
        tokenizer = new HuggingFaceTokenizer(config, { logger: this.logger })
        break
      case 'api':
        if (!config.endpoint) throw new Error('api tokenizer requires endpoint')
        tokenizer = new ApiTokenizer(config, { logger: this.logger })
        break
      default:
        throw new Error(`Unknown tokenizer type: ${config.type}`)
    }
    await tokenizer.initialize()
    return tokenizer
  }

  private cacheKey(config: ProviderTokenizerConfig): string {
    switch (config.type) {
      case 'tiktoken': {
        const model = config.model ? config.model : 'cl100k_base'
        return `tiktoken:${model}`
      }
      case 'huggingface':
        return `hf:${config.model}`
      case 'api':
        return `api:${config.endpoint}`
      default:
        return `unknown:${JSON.stringify(config)}`
    }
  }
}
