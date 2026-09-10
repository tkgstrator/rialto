/**
 * Can a subscription provider authenticate? Asked of its accounts, not
 * of one designated row.
 *
 * Providers used to carry `activeSubscriptionAccountId` — a single
 * account promoted at Connect time — and every "is this subscription
 * usable" gate read it. That made the provider's routability hostage to
 * whichever row held the slot: an account whose plan had not synced took
 * the whole provider out of Routing while its healthy peers sat there
 * unused. The question was always about the provider, so it is asked of
 * the provider's accounts here.
 *
 * Pure and import-free (see `transformer-chain.ts` for the pattern) so
 * the server gate and the Providers screen call the same function and
 * what the UI locks cannot drift from what routing accepts.
 */

// Structural on purpose: the API wire account, the UI's own copy of it
// and a Prisma row all satisfy it without a conversion step.
export interface SubscriptionCredentialAccount {
  enabled: boolean
  plan: string | null
}

/**
 * Enabled, and carrying a plan the vendor's profile call resolved —
 * which is the only evidence we hold that the credential is real.
 *
 * Deliberately not `authStatus === 'live'`: that is a probe verdict and
 * starts at `unknown`, so gating on it would strand every freshly
 * connected account until the auth-health job catches up.
 */
export const accountCanAuthenticate = (account: SubscriptionCredentialAccount): boolean =>
  account.enabled && account.plan !== null

export const hasAuthenticableAccount = (accounts: readonly SubscriptionCredentialAccount[]): boolean =>
  accounts.some(accountCanAuthenticate)

export interface ExpiringCredentialAccount extends SubscriptionCredentialAccount {
  // Epoch ms. Null when the vendor never stated one.
  expiresAt: number | null
}

/**
 * The stricter form the test paths want: an account that authenticates
 * AND whose stored access token has not run out. A live request would
 * rotate an expired token on the way through, but a test reporting
 * "works" off a token it never refreshed is reporting on nothing.
 */
export const accountCredentialUnexpired = (account: ExpiringCredentialAccount, now: number): boolean =>
  accountCanAuthenticate(account) && (account.expiresAt === null || account.expiresAt >= now)

export const hasUnexpiredAccount = (accounts: readonly ExpiringCredentialAccount[], now: number): boolean =>
  accounts.some((account) => accountCredentialUnexpired(account, now))
