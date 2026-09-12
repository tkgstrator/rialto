/**
 * The transformer chain a request through a provider runs.
 *
 * There is nothing to configure here, and no `provider.transformer.use`
 * to read. Each of the six registered transformers is either
 * endpoint-bound (`anthropic` / `openai` / `openai-responses` / `gemini`)
 * or auth-bound (`claude-code-oauth` / `codex-oauth`), so the chain is a
 * function of two stored columns — `Provider.apiStyle` and
 * `Provider.authMode` — plus the per-model `Model.apiStyle` override.
 *
 * Lives in `shared/` because both sides need the same answer and must not
 * be able to disagree: the runtime registry builds the chain from it, and
 * the Providers screen's read-only "Request shape" block displays it. It
 * is pure string mapping — no Prisma, no server imports — so the browser
 * bundle can carry it.
 */

export type ChainApiStyle = 'openai_chat' | 'openai_responses' | 'anthropic' | 'gemini'
export type ChainAuthMode = 'api_key' | 'subscription'

/** The fields the derivation reads. Both `Provider` projections satisfy it. */
export interface ChainProvider {
  name: string
  api_base_url: string
  auth_mode: ChainAuthMode
  api_style?: ChainApiStyle
}

/**
 * Wire-format conversion step for an apiStyle.
 *
 * `anthropic` has no outbound conversion step: the unified body is
 * Chat-shaped, not Anthropic-shaped. Native Anthropic traffic must instead
 * take the pipeline's passthrough path through a sole endpoint/auth step.
 * `transformerChain` selects `anthropic` for API keys or `claude-code-oauth`
 * for subscriptions; adding both would disable native passthrough.
 */
const CONVERSION_STEP: Record<ChainApiStyle, string | null> = {
  anthropic: null,
  openai_chat: 'openai',
  openai_responses: 'openai-responses',
  gemini: 'gemini'
}

/**
 * Subscription auth step for an apiStyle, always last in the chain — it
 * injects the bearer token the credential store holds. A style with no
 * entry has no subscription support in this build: such a provider is
 * unusable rather than merely unconverted, so the derivation reports it
 * as null instead of handing back a chain that would send unauthenticated
 * requests upstream.
 */
const SUBSCRIPTION_AUTH_STEP: Record<ChainApiStyle, string | null> = {
  anthropic: 'claude-code-oauth',
  openai_chat: null,
  openai_responses: 'codex-oauth',
  gemini: null
}

/**
 * Last-resort apiStyle for a subscription provider whose name told
 * `apiStyleForVendor` nothing.
 *
 * Subscription rows normally come from `SUBSCRIPTION_PRESETS`, whose ids
 * (`claude-code`, `codex`) the vendor map knows. A self-hosted proxy
 * carried over from a pre-Rialto config can sit under any name, and the
 * name map lands those on `openai_chat` — a style with no subscription
 * auth step, which would silently strip the provider of its credential.
 * The upstream it points at is the one signal left. Deliberately scoped
 * to subscription providers: `api.openai.com/v1/...` under an api_key
 * provider is the ordinary chat vendor, not a Codex backend.
 */
const subscriptionStyleFromBaseUrl = (apiBaseUrl: string): ChainApiStyle | null => {
  if (apiBaseUrl.includes('anthropic.com')) return 'anthropic'
  if (apiBaseUrl.includes('chatgpt.com') || apiBaseUrl.includes('openai.com/v1')) return 'openai_responses'
  return null
}

/**
 * The apiStyle the chain is actually built from. Equals the stored column
 * except for the self-hosted subscription proxy above. Null when the
 * provider predates the column and nothing can be inferred.
 */
export const effectiveApiStyle = (p: ChainProvider): ChainApiStyle | null => {
  const stored = p.api_style === undefined ? null : p.api_style
  if (p.auth_mode !== 'subscription') return stored
  if (stored !== null && SUBSCRIPTION_AUTH_STEP[stored] !== null) return stored
  return subscriptionStyleFromBaseUrl(p.api_base_url)
}

/**
 * Transformer names, in run order, for every request through this
 * provider.
 *
 * An Anthropic API-key provider needs its endpoint step so native requests
 * preserve their wire shape and use the API-key auth hook. Null means the
 * provider cannot be served; callers must leave it unregistered rather
 * than call an unsupported subscription provider without a credential.
 */
export const transformerChain = (p: ChainProvider): string[] | null => {
  const style = effectiveApiStyle(p)
  if (style === null) return null
  const conversion = CONVERSION_STEP[style]
  if (p.auth_mode !== 'subscription') return conversion === null ? ['anthropic'] : [conversion]
  const auth = SUBSCRIPTION_AUTH_STEP[style]
  if (auth === null) return null
  return conversion === null ? [auth] : [conversion, auth]
}

/**
 * Per-model chain for a model whose `Model.apiStyle` differs from its
 * provider's.
 *
 * One api_key provider hosts both wire formats — codex-family models on
 * the regular OpenAI provider are Responses-only and 404 against
 * /chat/completions — so those models need their own conversion step
 * appended after the provider chain. A model that agrees with its
 * provider gets nothing: appending the same step twice would convert the
 * body twice.
 *
 * Subscription providers are excluded. Their chain ends in an auth step
 * that must stay last, and no subscription vendor in this build hosts a
 * second wire format, so there is nothing here to express.
 */
export const modelTransformerChains = (
  p: ChainProvider,
  modelApiStyles: Readonly<Record<string, ChainApiStyle>> | undefined
): Record<string, string[]> => {
  if (modelApiStyles === undefined) return {}
  if (p.auth_mode === 'subscription') return {}
  const providerStyle = effectiveApiStyle(p)
  const out: Record<string, string[]> = {}
  for (const [model, style] of Object.entries(modelApiStyles)) {
    if (style === providerStyle) continue
    const conversion = CONVERSION_STEP[style]
    if (conversion === null) continue
    out[model] = [conversion]
  }
  return out
}
