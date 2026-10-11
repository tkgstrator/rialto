import { getPrismaClient } from '../db/client'
import { AuthMode, type PrismaClient } from '../generated/prisma/client'
import type { DiscoveredAccount } from '../schemas/domain/subscription'
import { codexChatgptUserId } from './codex-auth/claims'

export class AccountReauthenticationError extends Error {
  readonly status = 400
}

export async function reauthenticationTarget(
  kind: 'claude' | 'codex',
  id: string,
  prisma: PrismaClient = getPrismaClient()
) {
  const target = await prisma.subAccount.findUnique({ where: { id }, include: { provider: true } })
  if (target === null) throw new AccountReauthenticationError('The account to reauthenticate no longer exists.')
  const url = target.provider.apiBaseUrl
  const matches =
    kind === 'claude' ? url.includes('anthropic.com') : url.includes('chatgpt.com') || url.includes('openai.com/v1')
  if (target.provider.authMode !== AuthMode.subscription || !matches) {
    throw new AccountReauthenticationError(
      'The account to reauthenticate no longer exists or belongs to a different provider.'
    )
  }
  return target
}

type ReauthenticationIdentity = { userId: string | null; accountId: string | null; idToken: string | null }

const sameCodexUser = (target: ReauthenticationIdentity, account: DiscoveredAccount): boolean => {
  const previousUser = codexChatgptUserId(target.idToken)
  const nextUser = codexChatgptUserId(account.idToken)
  if (previousUser !== null && nextUser !== null) return previousUser === nextUser
  // Older credential imports may have no ID token. Retain their previous
  // matching rule rather than infer a user from an email or workspace alone.
  return target.userId === null || account.userId === null || target.userId === account.userId
}

export function assertReauthenticationIdentity(
  kind: 'claude' | 'codex',
  target: ReauthenticationIdentity,
  account: DiscoveredAccount
): void {
  if (kind === 'codex' && target.accountId !== null && target.accountId !== account.accountId) {
    throw new AccountReauthenticationError(
      'You signed in to a different ChatGPT workspace. Select the workspace linked to this account and try again. Nothing was saved.'
    )
  }
  const matches =
    kind === 'claude'
      ? target.userId !== null && target.userId === account.userId
      : target.accountId !== null
        ? sameCodexUser(target, account)
        : target.userId !== null && account.userId !== null && sameCodexUser(target, account)
  if (!matches)
    throw new AccountReauthenticationError(
      'You signed in to a different account. Sign in to the selected account to reauthenticate it. Nothing was saved.'
    )
}
