/**
 * Subscription-account persistence — DB only.
 *
 * SubAccount rows are created and updated through the web-UI OAuth flow
 * and credential import, both of which go through
 * subscription-connect-service: it proves the credentials with the vendor
 * first, then writes the account here with recordDiscoveredAccount.
 *   - claude: claudeAccountFromProfile(tokens, profile) keys the account on
 *     the profile's account uuid.
 *   - codex:  buildCodexDiscoveredAccount({ accessToken, refreshToken,
 *     idToken, accountId }) keys it on the account id carried by the file
 *     or the id_token claims.
 *
 * Tokens are AES-256-GCM-encrypted with the key derived from
 * `RIALTO_ACCOUNT_ENCRYPTION_KEY` (hex / base64 / passphrase, in that
 * preference order). Plain tokens never land on disk and never leave
 * memory after the upsert returns.
 *
 * getUsableSubAccountAuth(providerName) is the read path: decrypts and
 * returns the tokens of one account that can authenticate, for the
 * callers that need a credential rather than a specific account.
 *
 * The implementation lives in ./subscription-account-sync/*; this file
 * is the stable public entry point re-exporting that surface.
 */

export { decryptString } from './subscription-account-sync/crypto'
export { buildCodexDiscoveredAccount, claudeAccountFromProfile } from './subscription-account-sync/discovery'
export { recordDiscoveredAccount } from './subscription-account-sync/persist'
export { type ProfileSyncScope, syncSubAccountProfiles } from './subscription-account-sync/profile-sync'
export {
  getSubAccountTokensForKind,
  getSubAccountTokensForProvider,
  getUsableSubAccountAuth,
  type SubAccountTokenInfo,
  type UsableSubAccountAuth,
  updateSubAccountAccessToken
} from './subscription-account-sync/read'
