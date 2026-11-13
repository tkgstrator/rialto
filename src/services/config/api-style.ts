/**
 * Per-provider and per-model request shape resolution. There is no
 * runtime fallback — every seeded provider gets a concrete `ApiStyle`
 * value written to the DB, and per-model overrides are explicit.
 */

import { isCustomApiStyle } from '@/shared/custom-provider'
import { ApiStyle } from '../../generated/prisma/client'

// Explicit per-provider request shape. No runtime fallback — every
// seeded provider gets a concrete value written to the DB.
export const apiStyleForVendor = (name: string): ApiStyle => {
  if (name === 'anthropic' || name.startsWith('claude-code')) return ApiStyle.anthropic
  if (name === 'google') return ApiStyle.gemini
  if (name === 'codex') return ApiStyle.openai_responses
  return ApiStyle.openai_chat
}

/**
 * The style to store on a provider row.
 *
 * A catalog vendor's style is a fact about the vendor, so it comes from the
 * name and a payload cannot move it. A custom provider has no vendor to
 * derive it from: the operator chose it, and it has to survive every later
 * write. Most writes (a model switch, a key replacement) send the provider
 * back as the screen read it, `api_style` included, so the payload value is
 * honoured when it names one of the three styles a custom endpoint can have.
 * A payload without one (a config import, an older client) keeps what the
 * row already holds, and only a row that does not exist yet falls back to
 * the name-derived default.
 */
export const providerApiStyle = (
  name: string,
  custom: boolean,
  requested: ApiStyle | undefined,
  stored: ApiStyle | undefined
): ApiStyle => {
  if (!custom) return apiStyleForVendor(name)
  if (requested !== undefined && isCustomApiStyle(requested)) return requested
  return stored === undefined ? apiStyleForVendor(name) : stored
}

// Per-model override stored on Model.apiStyle. Codex-family models are
// Responses-only even when hosted under the regular (chat) openai
// provider, so they need an explicit endpoint stored on the row.
// Returns null when the model should inherit the provider's apiStyle.
//
// Only for the catalog's vendors. A custom provider's endpoint was chosen
// by the operator and serves whatever it serves: a `gpt-5-codex` listed by
// an Ollama box is no more Responses-only than its neighbours, so the name
// says nothing there and every row inherits the provider's style until the
// operator sets an override.
export const modelApiStyleOverride = (modelName: string, custom = false): ApiStyle | null =>
  !custom && /codex/i.test(modelName) ? ApiStyle.openai_responses : null
