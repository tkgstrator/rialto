// Subscription provider presets. Shared between the server (which
// seeds these as Provider rows with authMode=subscription) and the UI
// (which uses the vendor / cli / credentialsPath fields for hints in
// the Add Subscription dialog and to look up plan info).

export interface SubscriptionPreset {
  /** Provider.name in the DB and the Router key. */
  id: string
  /** Display label in the Add Subscription picker. */
  label: string
  /** Hint shown in the picker. */
  description: string
  /** Provider.apiBaseUrl in the DB. */
  apiBaseUrl: string
  /** Master list of models the subscription exposes. Used by seed + catalog view. */
  availableModels: string[]
  /** Subset that ships as enabled when a fresh provider is created. */
  defaultEnabledModels: string[]
  /**
   * Models the vendor's subscription backend refuses to serve, even if
   * the price scraper picks them up. The provider editor's toggle list
   * is derived from `provider.models` (DB) so scraped ids surface
   * automatically — this denylist hides the ones we know don't work.
   * Empty array when nothing to hide.
   */
  excludedModels: string[]
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
    availableModels: [
      'claude-fable-5',
      'claude-mythos-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5'
    ],
    // claude-mythos-5 is selectable (availableModels) but NOT enabled by
    // default: it's invitation-only (Project Glasswing) and a normal
    // Pro / Max subscription can't serve it, so enabling it out of the
    // box would 4xx for most users. Opt in from the UI when entitled.
    defaultEnabledModels: [
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5'
    ],
    vendor: 'Anthropic',
    cli: 'Claude',
    credentialsPath: '~/.claude/.credentials.json',
    excludedModels: []
  },
  {
    id: 'codex',
    label: 'Codex',
    description: 'ChatGPT subscription via Codex CLI OAuth',
    apiBaseUrl: 'https://chatgpt.com/backend-api/codex',
    // gpt-5.3-codex is rejected by the ChatGPT-account Codex backend
    // ("not supported when using Codex with a ChatGPT account"). The
    // OpenAI scraper already skips codex-family ids, so it wouldn't
    // reach the toggle list either way — kept in the seed list for the
    // Manage-providers catalog count.
    availableModels: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2', ...CODEX_IMAGE_MODELS],
    defaultEnabledModels: ['gpt-5.5'],
    vendor: 'OpenAI',
    cli: 'Codex',
    credentialsPath: '~/.codex/auth.json',
    excludedModels: []
  }
]

export const findSubscriptionPreset = (provider: { api_base_url: string }): SubscriptionPreset | undefined =>
  SUBSCRIPTION_PRESETS.find((p) => p.apiBaseUrl === provider.api_base_url)
