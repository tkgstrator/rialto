import seed from './llm-prices.json'

export { DEPRECATED_MODELS, isDeprecatedModel } from './deprecations'
export { SEED_PERSONAS, type SeedPersona } from './personas'
export { OFFICIAL_VENDOR_PRICES, type OfficialPricingEntry } from './providers'
export {
  CODEX_IMAGE_MODELS,
  findSubscriptionPreset,
  isCodexImageModel,
  SUBSCRIPTION_PRESETS,
  type SubscriptionPreset
} from './subscriptions'

export interface PriceEntry {
  id: string
  vendor: string
  name: string
  input: number
  output: number
  input_cached: number | null
}

export interface PriceSnapshot {
  updated_at: string
  prices: PriceEntry[]
}

export const LLM_PRICES_SEED: PriceSnapshot = seed

export type VendorAuth = 'bearer' | 'x-api-key' | 'google-key-param'

export interface VendorDefaults {
  /** Provider.apiBaseUrl */
  baseUrl: string
  /** GET endpoint returning the vendor's live model catalog */
  modelsEndpoint?: string
  /** How to attach the apiKey when calling modelsEndpoint */
  modelsAuth?: VendorAuth
}

// Vendors absent from this map are skipped: we can't infer a safe public
// endpoint for them (e.g. amazon needs per-region Bedrock signing).
export const VENDOR_DEFAULTS: Record<string, VendorDefaults> = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1/messages',
    modelsEndpoint: 'https://api.anthropic.com/v1/models',
    modelsAuth: 'x-api-key'
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/chat/completions',
    modelsEndpoint: 'https://api.deepseek.com/v1/models',
    modelsAuth: 'bearer'
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models/',
    modelsEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    modelsAuth: 'google-key-param'
  },
  minimax: { baseUrl: 'https://api.minimax.chat/v1/text/chatcompletion_v2' },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1/chat/completions',
    modelsEndpoint: 'https://api.mistral.ai/v1/models',
    modelsAuth: 'bearer'
  },
  'moonshot-ai': {
    baseUrl: 'https://api.moonshot.cn/v1/chat/completions',
    modelsEndpoint: 'https://api.moonshot.cn/v1/models',
    modelsAuth: 'bearer'
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    modelsEndpoint: 'https://api.openai.com/v1/models',
    modelsAuth: 'bearer'
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    modelsEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
    modelsAuth: 'bearer'
  },
  xai: {
    baseUrl: 'https://api.x.ai/v1/chat/completions',
    modelsEndpoint: 'https://api.x.ai/v1/models',
    modelsAuth: 'bearer'
  }
}

// Model prices no longer live in a frontend-facing static map. The DB is
// the single source of truth: the live scrape fills first-party vendor
// prices and backfillStaticPrices (model-sync-service) seeds the rest from
// llm-prices.json, so the UI reads prices via provider.modelPrices only.
