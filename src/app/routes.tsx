import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom'
import ProtectedRoute from '@/components/ProtectedRoute'
import { AccessTokens } from '@/components/rialto/AccessTokens'
import { ActivityLogs } from '@/components/rialto/activity/ActivityLogs'
import { ActivityRequests } from '@/components/rialto/activity/ActivityRequests'
import { ActivitySessionDetail } from '@/components/rialto/activity/ActivitySessionDetail'
import { ActivitySessions } from '@/components/rialto/activity/ActivitySessions'
import { ActivityUsage } from '@/components/rialto/activity/ActivityUsage'
import { Overview } from '@/components/rialto/Overview'
import { AddProviderScreen } from '@/components/rialto/providers/AddProviderScreen'
import { ProviderDetailScreen } from '@/components/rialto/providers/ProviderDetailScreen'
import { ProvidersScreen } from '@/components/rialto/providers/ProvidersScreen'
import { RialtoShell } from '@/components/rialto/RialtoShell'
import { RouteError } from '@/components/rialto/RouteError'
import { RoutingChain } from '@/components/rialto/routing/RoutingChain'
import { TokenDetail } from '@/components/rialto/settings/access/TokenDetail'
import { SettingsAccess } from '@/components/rialto/settings/SettingsAccess'
import { SettingsAdvanced } from '@/components/rialto/settings/SettingsAdvanced'
import { SettingsLogging } from '@/components/rialto/settings/SettingsLogging'
import { SettingsPersonas } from '@/components/rialto/settings/SettingsPersonas'
import { SettingsServer } from '@/components/rialto/settings/SettingsServer'
import { SettingsStatusline } from '@/components/rialto/settings/SettingsStatusline'
import { AccessRejectedScreen } from '@/components/rialto/system/AccessRejected'
import { NotFoundScreen } from '@/components/rialto/system/NotFound'
import { OauthResultScreen } from '@/components/rialto/system/OauthResult'
import { SetupScreen } from '@/components/rialto/system/SetupScreen'

export const router = createBrowserRouter([
  {
    // Root wrapper: gives every descendant a shared error boundary.
    // RouteError separates the two cases that land here — an unmatched
    // path and a component that threw — because telling someone their
    // bookmark moved when the app actually crashed sends them looking in
    // the wrong place.
    element: <Outlet />,
    errorElement: <RouteError />,
    children: [
      {
        // The new information architecture leads with Overview. /models
        // was the old landing and is now one tab inside Providers.
        path: '/',
        element: <Navigate to='/overview' replace />
      },
      {
        // Rialto shell (Phase 5). Every screen inside the five-item
        // information architecture hangs off here. ProtectedRoute no
        // longer guards a credential — Cloudflare Access does that at
        // the edge — it routes the two states the operator can act on.
        element: (
          <ProtectedRoute>
            <RialtoShell />
          </ProtectedRoute>
        ),
        children: [
          { path: '/overview', element: <Overview /> },
          // Providers is two lists and a detail, not one master-detail
          // screen. The rail that used to hold the master half grouped it
          // under these same two headings, and cost the detail half 288px
          // beside an already-256px sidebar.
          //
          // The section root redirects rather than rendering, because a
          // path that shows one of two peers without saying which is a
          // path the sidebar cannot highlight.
          { path: '/providers', element: <Navigate to='/providers/subscriptions' replace /> },
          // Static before dynamic so these three are what they say rather
          // than providers literally named "subscriptions", "api-keys" or
          // "connect".
          { path: '/providers/subscriptions', element: <ProvidersScreen kind='subscription' /> },
          { path: '/providers/api-keys', element: <ProvidersScreen kind='api_key' /> },
          { path: '/providers/connect', element: <AddProviderScreen /> },
          { path: '/providers/:name', element: <ProviderDetailScreen /> },
          // The chain is the whole of Routing. The map and the rule
          // editor described the scenario router, which no longer decides
          // anything, and a screen that edits a selector nothing runs is
          // worse than no screen.
          { path: '/routing', element: <RoutingChain /> },
          // Top level, beside Providers: outbound and inbound at the same
          // depth. These were /settings/access and
          // /settings/access/tokens/:id.
          { path: '/access-tokens', element: <AccessTokens /> },
          { path: '/access-tokens/:id', element: <TokenDetail /> },
          { path: '/activity', element: <ActivitySessions /> },
          { path: '/activity/requests', element: <ActivityRequests /> },
          { path: '/activity/sessions/:sessionId', element: <ActivitySessionDetail /> },
          { path: '/activity/usage', element: <ActivityUsage /> },
          { path: '/activity/logs', element: <ActivityLogs /> },
          { path: '/settings', element: <SettingsServer /> },
          { path: '/settings/access', element: <SettingsAccess /> },
          { path: '/settings/logging', element: <SettingsLogging /> },
          { path: '/settings/personas', element: <SettingsPersonas /> },
          { path: '/settings/statusline', element: <SettingsStatusline /> },
          { path: '/settings/advanced', element: <SettingsAdvanced /> }
        ]
      },
      {
        // Public — the IdP redirects browsers here after a server-side
        // token exchange. Token persistence already happened by the time
        // this route mounts; the page is read-only.
        path: '/oauth-result',
        element: <OauthResultScreen />
      },
      // First run and the Access-denied explanation render without the
      // shell: the first has no configuration to hang a sidebar off yet,
      // and the second is what the operator sees when the edge refused
      // them, so the app chrome would be misleading.
      { path: '/setup', element: <SetupScreen /> },
      { path: '/access-denied', element: <AccessRejectedScreen /> },
      {
        path: '*',
        element: <NotFoundScreen />
      }
    ]
  }
])
