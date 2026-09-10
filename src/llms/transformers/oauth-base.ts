/**
 * Shared scaffolding for subscription-OAuth transformers (claude-code,
 * codex, …). Credentials come from the DB, resolved per request: the
 * session-account picker first, then a caller-supplied block (probes),
 * then any account on the provider. There is no disk fallback.
 * Concrete subclasses opt into a near-expiry refresh by overriding
 * `refresh()`; the base owns the in-flight dedup so concurrent requests
 * don't race the upstream refresh endpoint with the same single-use
 * refresh_token.
 */

import { HTTPException } from 'hono/http-exception'
import type { RuntimeProvider } from '@/schemas/domain/pipeline'
import { type OauthCredentials, OauthSubscriptionAuthBlockSchema } from '@/schemas/wire/oauth'
import { logger } from '../../logger'
import { withRefreshLock } from '../../services/oauth/refresh-lock'
import { resolveAccountForSession } from '../../services/session-account-router'
import { getUsableSubAccountAuth, updateSubAccountAccessToken } from '../../services/subscription-account-sync-service'
import { Transformer } from './base'

export type { OauthCredentials } from '@/schemas/wire/oauth'
export interface OAuthRefreshResult {
  accessToken: string
  refreshToken?: string | null
  expiresAt?: Date | null
}

/** The stored credential state a freshness check operates on. */
export interface SubscriptionTokenState {
  subAccountId: string
  accessToken: string
  refreshToken: string
  expiresAt: Date | null
}

// Refresh ~5 minutes before the upstream-stated expiry so a long-running
// request started right at the threshold doesn't 401 mid-flight.
const REFRESH_LEEWAY_MS = 5 * 60 * 1000

export abstract class OAuthTransformer extends Transformer {
  /**
   * Vendor-specific refresh hook. Default is "no refresh" — the
   * transformer relies on the user re-running OAuth before the token
   * expires. Override to hit the vendor's refresh endpoint with the
   * stored refresh_token and return the rotated grant.
   */
  protected async refresh(_input: { refreshToken: string }): Promise<OAuthRefreshResult | null> {
    return null
  }

  /**
   * The model a request asks for, read defensively off the vendor body.
   *
   * The account picker needs it because a subscription's per-model
   * weekly windows (Anthropic's `limits[]`, e.g. Fable) bind only for
   * that model — without it the picker can only consult the
   * account-wide windows and will happily hand back an account whose
   * Fable allowance is gone.
   */
  private modelOf(request: unknown): string | undefined {
    if (request === null || typeof request !== 'object') return undefined
    if (!('model' in request)) return undefined
    const model = request.model
    return typeof model === 'string' && model.length > 0 ? model : undefined
  }

  /** Freshen a resolved account's token and shape it for the caller. */
  private async credentialsFor(auth: {
    subAccountId: string
    accessToken: string
    refreshToken: string | null
    accountId: string | null
    expiresAt: Date | null
  }): Promise<OauthCredentials> {
    const live = await this.ensureFreshToken({
      subAccountId: auth.subAccountId,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken === null ? '' : auth.refreshToken,
      expiresAt: auth.expiresAt
    })
    return auth.accountId === null ? { token: live } : { token: live, accountId: auth.accountId }
  }

  protected async resolveSubscriptionAuth(
    provider: RuntimeProvider | null | undefined,
    sessionId?: string | null,
    kind?: 'claude' | 'codex',
    request?: unknown
  ): Promise<OauthCredentials> {
    // Session-aware path: pick the account by session continuity, or by
    // which one has the most quota left to burn. This is the path all
    // proxied traffic takes.
    if (sessionId && kind) {
      const account = await resolveAccountForSession(sessionId, kind, this.modelOf(request))
      if (account) {
        return this.credentialsFor({
          subAccountId: account.subAccountId,
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          accountId: account.accountId,
          expiresAt: account.expiresAt
        })
      }
    }

    // A caller that brought its own credential block instead of a
    // session: the model-test probes, which build the same upstream
    // request as the proxy off one account they already read.
    const parsed = OauthSubscriptionAuthBlockSchema.safeParse(
      // biome-ignore plugin: provider.transformer is the pipeline-owned `Record<string, unknown>` overlay; safeParse narrows the subscriptionAuth block from there.
      (provider?.transformer as Record<string, unknown> | undefined)?.subscriptionAuth
    )
    if (parsed.success) {
      const auth = parsed.data
      return this.credentialsFor({
        subAccountId: auth.subAccountId,
        accessToken: auth.accessToken,
        refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : null,
        accountId: typeof auth.accountId === 'string' ? auth.accountId : null,
        expiresAt: auth.expiresAt === undefined ? null : auth.expiresAt
      })
    }

    // Last resort: any account on this provider that can authenticate.
    // Reached when the picker found no candidates for the kind — it
    // sniffs the kind from the provider's base URL, so a subscription
    // provider on an unrecognised host lands here — and refusing a
    // provider that does hold usable credentials would be a lie.
    const fallback =
      provider?.name === undefined ? null : await getUsableSubAccountAuth(provider.name).catch(() => null)
    if (fallback?.accessToken) {
      return this.credentialsFor({
        subAccountId: fallback.subAccountId,
        accessToken: fallback.accessToken,
        refreshToken: fallback.refreshToken,
        accountId: fallback.accountId,
        expiresAt: fallback.expiresAt
      })
    }

    throw new HTTPException(401, {
      message:
        'No usable subscription account for this provider. Sign in via Settings → Providers → Connect, then retry.'
    })
  }

  /**
   * Return a usable access token for the resolved account, rotating it
   * first when it is at or near expiry.
   *
   * The default reads the stored `expiresAt` and delegates the actual
   * grant call to `refresh()`. Vendors whose token states its own expiry
   * (Codex, via the JWT `exp` claim) override this so a stale or
   * mis-written column cannot suppress the refresh.
   *
   * Never throws: on failure it returns the token we already hold and
   * lets the upstream 401 drive re-authentication.
   */
  protected async ensureFreshToken(auth: SubscriptionTokenState): Promise<string> {
    if (auth.expiresAt === null) return auth.accessToken
    if (auth.expiresAt.valueOf() - Date.now() > REFRESH_LEEWAY_MS) return auth.accessToken
    if (auth.refreshToken.length === 0) return auth.accessToken

    return withRefreshLock(auth.subAccountId, async () => {
      try {
        const next = await this.refresh({ refreshToken: auth.refreshToken })
        if (!next) return auth.accessToken
        await updateSubAccountAccessToken(auth.subAccountId, {
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
          expiresAt: next.expiresAt
        })
        return next.accessToken
      } catch (err) {
        // Refresh failures fall back to the existing access token; the
        // upstream call will likely 401 and the user re-authenticates.
        // Log the failure so operators can tell "refresh path is broken"
        // from "user genuinely revoked" — the silent-catch that lived
        // here for months hid rotation-race + prisma-write faults
        // completely, so the only signal was users being asked to
        // re-import auth.json on every expiry.
        logger.warn(
          { subAccountId: auth.subAccountId, err },
          '[oauth-base] on-demand token refresh failed, falling back to existing access token'
        )
        return auth.accessToken
      }
    })
  }
}
