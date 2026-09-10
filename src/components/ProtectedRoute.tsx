import { Navigate } from 'react-router-dom'
import { useConfig } from '@/components/ConfigProvider'
import { isFreshInstall, setupAlreadyOffered } from '@/components/rialto/system/first-run'

/**
 * The gate in front of the Rialto shell.
 *
 * It no longer collects a credential. Cloudflare Access authenticates the
 * operator at the edge and `adminAuth` verifies the assertion it forwards
 * (`src/api/api-key-auth.ts`), so the browser holds nothing it could
 * present instead — the old `/login` form was a second, weaker
 * authentication system standing beside the real one, and the weaker one
 * is the one an attacker uses. It is gone, along with its route.
 *
 * What is left are the two states the operator can still act on:
 *
 * - `/api/*` answered 401: the request came neither from this machine nor
 *   with an Access assertion that verified. Nothing inside the app can fix
 *   that, so `/access-denied` names what to change rather than rendering a
 *   shell with no data in it.
 * - The database holds no providers at all. `/setup` is then the only
 *   page with anything to say, and it is offered once per tab so its own
 *   "Skip setup" link still works.
 */
const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { config, authFailed } = useConfig()
  if (authFailed) return <Navigate to='/access-denied' replace />
  if (isFreshInstall(config) && !setupAlreadyOffered()) return <Navigate to='/setup' replace />
  return children
}

export default ProtectedRoute
