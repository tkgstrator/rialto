// Subscription provider presets. Shared between the server (which
// creates these as Provider rows with authMode=subscription) and the UI
// (which uses the vendor / cli / credentialsPath fields for hints in
// the Add Subscription dialog and to look up plan info).
//
// A preset names no models. Which models a subscription has comes from
// the vendor (the Claude Code catalog, the Codex account's model list),
// and every one lands switched off: nothing here may decide on the
// operator's behalf which model serves, since nobody knows what the next
// release will be.

export interface SubscriptionPreset {
  /** Provider.name in the DB and the Router key. */
  id: string
  /** Display label in the Add Subscription picker. */
  label: string
  /** Hint shown in the picker. */
  description: string
  /** Provider.apiBaseUrl in the DB. */
  apiBaseUrl: string
  /** Vendor brand surfaced in the subscription hint (e.g. Anthropic, OpenAI). */
  vendor: string
  /** CLI name that mints the OAuth token (e.g. Claude, Codex). */
  cli: string
  /** Path where the server picks up the OAuth credentials at request time. */
  credentialsPath: string
}

// These models use the Codex image JSON endpoint, not Responses/chat.
export const CODEX_IMAGE_MODELS: readonly string[] = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']
export const isCodexImageModel = (name: string): boolean => CODEX_IMAGE_MODELS.includes(name)

export const SUBSCRIPTION_PRESETS: SubscriptionPreset[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    description: 'Claude Pro / Max subscription via Claude CLI OAuth',
    apiBaseUrl: 'https://api.anthropic.com/v1/messages',
    vendor: 'Anthropic',
    cli: 'Claude',
    credentialsPath: '~/.claude/.credentials.json'
  },
  {
    id: 'codex',
    label: 'Codex',
    description: 'ChatGPT subscription via Codex CLI OAuth',
    apiBaseUrl: 'https://chatgpt.com/backend-api/codex',
    vendor: 'OpenAI',
    cli: 'Codex',
    credentialsPath: '~/.codex/auth.json'
  }
]

export const findSubscriptionPreset = (provider: { api_base_url: string }): SubscriptionPreset | undefined =>
  SUBSCRIPTION_PRESETS.find((p) => p.apiBaseUrl === provider.api_base_url)
