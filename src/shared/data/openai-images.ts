import { apiKeyProviderBaseName } from '../api-key-provider-id'
import { isCodexImageModel } from './subscriptions'

export const OPENAI_IMAGE_MODELS: readonly string[] = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst']

// Text input and image output, the modalities used by the generation surface.
export const OPENAI_IMAGE_GENERATION_PRICE = { inputPer1M: 5, outputPer1M: 30, cachedInputPer1M: 1.25 }
export const CODEX_IMAGE_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export const OPENAI_IMAGE_ENDPOINT = 'https://api.openai.com/v1/images/generations'

export const isOpenAIImageModel = (model: string): boolean => OPENAI_IMAGE_MODELS.includes(model)
export const isImageOnlyModel = (model: string): boolean => isOpenAIImageModel(model) || isCodexImageModel(model)

export function isOfficialOpenAIApiProvider(provider: { name: string; authMode: string; apiBaseUrl: string }): boolean {
  return (
    apiKeyProviderBaseName(provider.name) === 'openai' &&
    provider.authMode === 'api_key' &&
    /^https:\/\/api\.openai\.com\/v1(?:\/(?:chat\/completions|responses))?\/?$/.test(provider.apiBaseUrl)
  )
}

export function supportsImageModel(
  provider: { name: string; authMode: string; apiBaseUrl: string },
  model: string
): boolean {
  return isOpenAIImageModel(model)
    ? isOfficialOpenAIApiProvider(provider)
    : isCodexImageModel(model) && provider.authMode === 'subscription' && provider.apiBaseUrl === CODEX_IMAGE_BASE_URL
}
