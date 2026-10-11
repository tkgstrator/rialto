import { AccountReauthenticationError } from '../../services/account-reauthentication'
import { AccountConnectError } from '../../services/subscription-connect-service'

// How a failed connection is answered. A refusal from connecting carries
// its own status — bad credentials are the caller's to fix, an unreachable
// vendor is not — and anything else stays the 500 it always was.
export const connectFailure = (
  err: unknown,
  fallback: string
): { body: { success: false; error: string }; status: 400 | 500 | 502 } => {
  if (err instanceof AccountConnectError || err instanceof AccountReauthenticationError)
    return { body: { success: false, error: err.message }, status: err.status }
  return { body: { success: false, error: err instanceof Error ? err.message : fallback }, status: 500 }
}
