import type { Hono } from 'hono'
import { getPrismaClient } from '../../db/client'
import { logger } from '../../logger'
import { ClaudeCredentialsFileSchema, CodexCredentialsFileSchema } from '../../schemas/wire/oauth'
import { CLAUDE_SCOPES } from '../../services/claude-oauth-service'
import { providersForKind } from '../../services/subscription-account-sync/persist'
import { getUsableSubAccountAuth } from '../../services/subscription-account-sync/read'
import { connectClaudeAccount, connectCodexAccount } from '../../services/subscription-connect-service'
import { connectFailure } from './connect-failure'
import { requestedReauthenticationTarget } from './reauthentication-target'

export function registerCredentialRoutes(oauthRoute: Hono): void {
  // Bypass the OAuth dance: accept a raw credential payload and connect the
  // account from it. Useful for remote deployments where the loopback
  // callback is unreachable and the user already has a credentials file.
  oauthRoute.post('/api/oauth/import-credentials', async (c) => {
    const body = await c.req.json<{ provider: string; credentials: unknown; targetAccountId?: string }>()

    // A payload the schema refuses is answered with the schema's own reasons.
    // "Not a credentials file" alone sent an operator hunting for a format
    // problem in a file that only lacked the field naming the account.
    const notCredentials = (vendor: 'Claude' | 'Codex', file: string, issues: readonly { message: string }[]) => ({
      success: false as const,
      error: `Not a ${vendor} credentials file (${file}): ${issues.map((issue) => issue.message).join('; ')}`
    })

    if (body.provider === 'claude') {
      const parsed = ClaudeCredentialsFileSchema.safeParse(body.credentials)
      if (!parsed.success) {
        return c.json(notCredentials('Claude', '~/.claude/.credentials.json', parsed.error.issues), 400)
      }
      const { accessToken, refreshToken, expiresAt, scopes } = parsed.data
      try {
        const targetAccountId = await requestedReauthenticationTarget('claude', body)
        await connectClaudeAccount(
          {
            accessToken,
            refreshToken,
            expiresAt: typeof expiresAt === 'number' ? expiresAt : null,
            scopes: scopes === undefined ? CLAUDE_SCOPES : scopes
          },
          undefined,
          targetAccountId
        )
        return c.json({ success: true as const })
      } catch (err) {
        logger.error({ err }, '[oauth] import-credentials (claude) failed')
        const failure = connectFailure(err, 'Failed to record account.')
        return c.json(failure.body, failure.status)
      }
    }

    if (body.provider === 'codex') {
      const parsed = CodexCredentialsFileSchema.safeParse(body.credentials)
      if (!parsed.success) {
        return c.json(notCredentials('Codex', '~/.codex/auth.json', parsed.error.issues), 400)
      }
      try {
        const targetAccountId = await requestedReauthenticationTarget('codex', body)
        await connectCodexAccount(parsed.data, undefined, targetAccountId)
        return c.json({ success: true as const })
      } catch (err) {
        logger.error({ err }, '[oauth] import-credentials (codex) failed')
        const failure = connectFailure(err, 'Failed to record account.')
        return c.json(failure.body, failure.status)
      }
    }

    return c.json({ success: false as const, error: `Unsupported provider "${body.provider}".` }, 400)
  })

  // Symmetric to import-credentials: decrypt the ACTIVE SubAccount's
  // tokens for the given kind and return them in the ~/.claude/.credentials.json
  // / ~/.codex/auth.json wire shape — the exact bytes import-credentials
  // accepts, so a backup taken from this endpoint round-trips into another
  // Rialto (or the on-disk CLI file) without hand-editing.
  //
  // Response carries Content-Disposition: attachment with a stable
  // filename so a browser download prompt fires; XHR / SDK callers keep
  // the JSON body untouched. Cache-control: no-store because the body is
  // secret material.
  //
  // Only the active account is exported — the same one the proxy hot path
  // would use for outbound OAuth calls right now.
  oauthRoute.post('/api/oauth/export-credentials', async (c) => {
    const body = await c.req.json<{ provider: string }>().catch(() => ({ provider: '' }))
    if (body.provider !== 'claude' && body.provider !== 'codex') {
      return c.json({ success: false as const, error: `Unsupported provider "${body.provider}".` }, 400)
    }
    const kind: 'claude' | 'codex' = body.provider
    const prisma = getPrismaClient()
    const kindProviders = await providersForKind(prisma, kind)
    if (kindProviders.length === 0) {
      return c.json({ success: false as const, error: `No subscription provider registered for "${kind}".` }, 404)
    }

    // Walk every provider that matches this vendor kind (usually one:
    // claude-code / codex) and take the first account that can
    // authenticate. With several connected accounts this exports one of
    // them, not "the" one: nothing designates an account any more, and the
    // proxy spreads traffic across all of them per request.
    for (const p of kindProviders) {
      const auth = await getUsableSubAccountAuth(p.name, prisma)
      if (!auth || !auth.accessToken) continue

      if (kind === 'claude') {
        const sub = await prisma.subAccount.findUnique({
          where: { id: auth.subAccountId },
          select: { scopes: true }
        })
        const rawScopes: unknown = sub?.scopes
        const scopes: string[] = Array.isArray(rawScopes)
          ? rawScopes.filter((s): s is string => typeof s === 'string')
          : []
        const file = {
          claudeAiOauth: {
            accessToken: auth.accessToken,
            refreshToken: auth.refreshToken ?? '',
            expiresAt: auth.expiresAt ? auth.expiresAt.valueOf() : null,
            scopes
          }
        }
        c.header('content-disposition', 'attachment; filename="claude-credentials.json"')
        c.header('cache-control', 'no-store')
        return c.json(file, 200)
      }

      // codex: an import needs SOMETHING to identify the account with —
      // either the id_token (claims carry chatgpt_account_id) or the
      // account_id itself. Emit both when we have them; refuse only when
      // neither is stored, since that payload would 400 straight back on
      // import and the operator has to re-OAuth to fix it.
      if (!auth.idToken && !auth.accountId) {
        logger.warn(
          { provider: p.name, subAccountId: auth.subAccountId },
          '[oauth] export-credentials: neither id_token nor account_id stored on codex account; re-authenticate to refresh'
        )
        return c.json(
          {
            success: false as const,
            error:
              'Stored codex account has no id_token or account_id to export (created before either was captured). Re-authenticate via Settings → Providers → Connect and retry.'
          },
          409
        )
      }
      const file = {
        tokens: {
          access_token: auth.accessToken,
          refresh_token: auth.refreshToken ?? '',
          ...(auth.idToken ? { id_token: auth.idToken } : {}),
          ...(auth.accountId ? { account_id: auth.accountId } : {})
        }
      }
      c.header('content-disposition', 'attachment; filename="codex-auth.json"')
      c.header('cache-control', 'no-store')
      return c.json(file, 200)
    }

    return c.json({ success: false as const, error: `No active subscription account for "${kind}".` }, 404)
  })
}
