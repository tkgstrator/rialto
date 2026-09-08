import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom'
import ProtectedRoute from '@/components/ProtectedRoute'
import { ActivityLogs } from '@/components/rialto/activity/ActivityLogs'
import { ActivityRequests } from '@/components/rialto/activity/ActivityRequests'
import { ActivitySessionDetail } from '@/components/rialto/activity/ActivitySessionDetail'
import { ActivitySessions } from '@/components/rialto/activity/ActivitySessions'
import { ActivityUsage } from '@/components/rialto/activity/ActivityUsage'
import { Overview } from '@/components/rialto/Overview'
import { AddProviderScreen } from '@/components/rialto/providers/AddProviderScreen'
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
          { path: '/providers', element: <ProvidersScreen /> },
          // Static before dynamic so /providers/connect is the add flow
          // rather than a provider literally named "connect".
          { path: '/providers/connect', element: <AddProviderScreen /> },
          { path: '/providers/:name', element: <ProvidersScreen /> },
          // The chain is the whole of Routing. The map and the rule
          // editor described the scenario router, which no longer decides
          // anything, and a screen that edits a selector nothing runs is
          // worse than no screen.
          { path: '/routing', element: <RoutingChain /> },
          { path: '/activity', element: <ActivitySessions /> },
          { path: '/activity/requests', element: <ActivityRequests /> },
          { path: '/activity/sessions/:sessionId', element: <ActivitySessionDetail /> },
          { path: '/activity/usage', element: <ActivityUsage /> },
          { path: '/activity/logs', element: <ActivityLogs /> },
          { path: '/settings', element: <SettingsServer /> },
          { path: '/settings/access', element: <SettingsAccess /> },
          // A token's own page: where rotate, revoke and delete live, so
          // none of them is a row action on a table of live credentials.
          { path: '/settings/access/tokens/:id', element: <TokenDetail /> },
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
