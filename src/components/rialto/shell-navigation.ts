import type { Provider } from '@/schemas/domain/provider'

/** A destination. Sub-entries are leaves, which is why they are a type of
 *  their own rather than a NavEntry with an empty list to carry around. */
export interface NavChild {
  id: string
  labelKey: string
  icon: string
  href: string
}

export interface NavEntry extends NavChild {
  children: readonly NavChild[]
}

/**
 * Sub-entries carry no counts on purpose. A menu answers "where can I go",
 * not "how much is in there", and those numbers move on every request — a
 * sidebar carrying them ticks in the corner of the eye while you read
 * something else. The screens still show them where the data is.
 */
export const NAV: readonly NavEntry[] = [
  { id: 'overview', labelKey: 'shell.navOverview', icon: 'ri-dashboard-3-line', href: '/overview', children: [] },
  // Routing has no children: the chain IS the screen, and it is the only
  // selector.
  { id: 'routing', labelKey: 'shell.navRouting', icon: 'ri-git-branch-line', href: '/routing', children: [] },
  { id: 'decisions', labelKey: 'shell.navDecisions', icon: 'ri-code-box-line', href: '/decisions', children: [] },
  // Neither child is href '/providers' — the section root redirects to
  // the first instead. Activity and Settings can let their first child
  // hold the section's own path because `childOf` matches by prefix and
  // every deeper route of theirs belongs to that child. Here it does
  // not: `/providers/openai` is an api_key provider, and a Subscriptions
  // child at '/providers' would light up on it.
  {
    id: 'providers',
    labelKey: 'shell.navProviders',
    icon: 'ri-plug-line',
    href: '/providers',
    children: [
      {
        id: 'subscriptions',
        labelKey: 'providers.rail.subscriptions',
        icon: 'ri-shield-user-line',
        href: '/providers/subscriptions'
      },
      { id: 'api-keys', labelKey: 'providers.rail.apiKeys', icon: 'ri-key-line', href: '/providers/api-keys' },
      { id: 'models', labelKey: 'providers.models.listTitle', icon: 'ri-list-check-2', href: '/providers/models' },
      { id: 'priorities', labelKey: 'providers.priorities.nav', icon: 'ri-sort-asc', href: '/providers/priorities' }
    ]
  },
  // Next to Providers because it is the same question pointed the other
  // way: Providers is outbound (who Rialto sends to), this is inbound
  // (who may send to Rialto). It lived under Settings, where a list
  // carrying per-token spend, rotation and revocation does not belong —
  // that is operations, not configuration. Settings → Access keeps the
  // half that really is configuration: who may administer the install.
  {
    id: 'access-tokens',
    labelKey: 'shell.navAccessTokens',
    icon: 'ri-key-2-line',
    href: '/access-tokens',
    children: []
  },
  {
    id: 'activity',
    labelKey: 'shell.navActivity',
    icon: 'ri-pulse-line',
    href: '/activity',
    children: [
      { id: 'sessions', labelKey: 'activity.common.tabSessions', icon: 'ri-chat-1-line', href: '/activity' },
      { id: 'requests', labelKey: 'activity.common.tabRequests', icon: 'ri-exchange-line', href: '/activity/requests' },
      { id: 'usage', labelKey: 'activity.common.tabUsage', icon: 'ri-battery-2-line', href: '/activity/usage' },
      { id: 'logs', labelKey: 'activity.common.tabLogs', icon: 'ri-file-list-2-line', href: '/activity/logs' }
    ]
  },
  {
    id: 'settings',
    labelKey: 'shell.navSettings',
    icon: 'ri-settings-3-line',
    href: '/settings',
    children: [
      { id: 'server', labelKey: 'settings.rail.server', icon: 'ri-server-line', href: '/settings' },
      { id: 'access', labelKey: 'settings.rail.access', icon: 'ri-key-2-line', href: '/settings/access' },
      { id: 'logging', labelKey: 'settings.rail.logging', icon: 'ri-file-list-2-line', href: '/settings/logging' },
      { id: 'personas', labelKey: 'settings.rail.personas', icon: 'ri-user-voice-line', href: '/settings/personas' },
      { id: 'advanced', labelKey: 'settings.rail.advanced', icon: 'ri-terminal-box-line', href: '/settings/advanced' }
    ]
  }
]

/** Which top-level section a path belongs to. */
export function sectionOf(pathname: string): NavEntry | undefined {
  return NAV.find((entry) => pathname === entry.href || pathname.startsWith(`${entry.href}/`))
}

/**
 * The deepest child a path matches. Longest href first so `/routing/map`
 * does not resolve to `/routing`, which every routing path starts with.
 */
export function childOf(pathname: string): NavChild | undefined {
  const section = sectionOf(pathname)
  if (section === undefined) return undefined
  return [...section.children]
    .sort((a, b) => b.href.length - a.href.length)
    .find((child) => pathname === child.href || pathname.startsWith(`${child.href}/`))
}

/** Provider section pages that are not a provider's own detail. */
const PROVIDER_NON_DETAIL_SEGMENTS = new Set(['subscriptions', 'api-keys', 'models', 'connect'])

/**
 * The Providers sub-entry a provider's own detail page belongs to.
 *
 * `childOf` cannot answer this from the URL alone — see the comment on the
 * `providers` NAV entry above: a provider is named by the operator, not by
 * which list it lives on, so `/providers/openai` carries no prefix that
 * says "api-keys" or "subscriptions". The provider's own `auth_mode` is
 * the only thing that says which list it belongs to, so this reads it out
 * of `config.Providers` — already mounted by ConfigProvider for every
 * screen — rather than fetching the provider list again just to light up
 * a sidebar row. Returns undefined (no highlight) until config has loaded
 * or for a name no provider has, same as the mock's active state never
 * disagreeing with what it can actually show.
 */
export function providerListChildOf(
  pathname: string,
  providers: readonly Pick<Provider, 'name' | 'auth_mode'>[]
): NavChild | undefined {
  const match = /^\/providers\/([^/]+)$/.exec(pathname)
  if (match === null) return undefined
  const name = match[1]
  if (PROVIDER_NON_DETAIL_SEGMENTS.has(name)) return undefined
  const provider = providers.find((p) => p.name === name)
  if (provider === undefined) return undefined
  const providersEntry = NAV.find((entry) => entry.id === 'providers')
  const childId = provider.auth_mode === 'subscription' ? 'subscriptions' : 'api-keys'
  return providersEntry?.children.find((child) => child.id === childId)
}
