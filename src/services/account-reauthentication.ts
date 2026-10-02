import { getPrismaClient } from '../db/client'
import { AuthMode, type PrismaClient } from '../generated/prisma/client'
import type { DiscoveredAccount } from '../schemas/domain/subscription'

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

export function assertReauthenticationIdentity(
  kind: 'claude' | 'codex',
  target: { userId: string | null; accountId: string | null },
  account: DiscoveredAccount
): void {
  const matches =
    kind === 'claude'
      ? target.userId !== null && target.userId === account.userId
      : target.accountId !== null
        ? target.accountId === account.accountId &&
          (target.userId === null || account.userId === null || target.userId === account.userId)
        : target.userId !== null && target.userId === account.userId
  if (!matches)
    throw new AccountReauthenticationError(
      'You signed in to a different account. Sign in to the selected account to reauthenticate it. Nothing was saved.'
    )
}
