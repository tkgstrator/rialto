/**
 * Typed Hono context variables.
 *
 * The auth middleware resolves who is calling and the routes downstream
 * need that answer. Declaring the shape here means `c.get('accessToken')`
 * is typed at every read instead of each handler asserting it back into
 * existence.
 */

import type { ResolvedToken } from '../services/access-token-service'

/**
 * How an /api request got past the gate.
 *
 * Two answers, and they are not interchangeable: `local` means no
 * credential was presented or needed, which is not the same as an Access
 * assertion having been checked. There is no third — the envelope
 * bootstrap token that used to be one is gone.
 */
export type AuthVia = 'local' | 'cloudflare_access'

declare module 'hono' {
  interface ContextVariableMap {
    /** Which path admitted this request. */
    authVia: AuthVia
    /** Email from a verified Access assertion. Absent on the other paths. */
    accessEmail: string | null
    /** The issued token that authenticated a /v1 call, when one did. */
    accessToken: ResolvedToken
  }
}
