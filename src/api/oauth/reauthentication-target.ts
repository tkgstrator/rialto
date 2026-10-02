import { z } from '@hono/zod-openapi'
import { AccountReauthenticationError, reauthenticationTarget } from '../../services/account-reauthentication'

const requestSchema = z.object({ targetAccountId: z.string().nonempty().optional() })

export async function requestedReauthenticationTarget(
  kind: 'claude' | 'codex',
  body: unknown
): Promise<string | undefined> {
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) throw new AccountReauthenticationError('Invalid account to reauthenticate.')
  const id = parsed.data.targetAccountId
  if (id !== undefined) await reauthenticationTarget(kind, id)
  return id
}
