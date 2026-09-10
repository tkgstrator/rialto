/**
 * Subscription-account persistence — DB only.
 *
 * SubAccount rows are created and updated exclusively through the
 * web-UI OAuth flow:
 *   - claude: recordClaudeOAuthAccount({ accessToken, refreshToken,
 *     expiresAt, scopes }) — pulls the user's profile via
 *     fetchClaudeProfile and writes an encrypted row.
 *   - codex:  recordCodexOAuthAccount({ accessToken, refreshToken,
 *     idToken }) — decodes id_token claims for identity + plan info
 *     and writes an encrypted row.
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
export { recordClaudeOAuthAccount, recordCodexOAuthAccount } from './subscription-account-sync/persist'
export { syncSubAccountProfiles } from './subscription-account-sync/profile-sync'
export {
  getSubAccountTokensForKind,
  getUsableSubAccountAuth,
  type SubAccountTokenInfo,
  type UsableSubAccountAuth,
  updateSubAccountAccessToken
} from './subscription-account-sync/read'
