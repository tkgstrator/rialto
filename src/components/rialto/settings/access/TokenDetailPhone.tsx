/**
 * One access token at phone width.
 *
 * What a phone is for here is the check and the emergency: is this client
 * still inside its plan, what has it been doing, and — if the secret has
 * leaked — rotate or revoke it now. Those stay, in that order. The scope
 * and plan editors do not: each is a picker laid out beside a
 * paragraph of explanation, and a scope change reaches a live client as a
 * 401 nobody can trace from that end, which is not a change to make on a
 * 390px screen. They are read out as plain facts instead, and edited on
 * the same page at desktop width.
 */

import { useTranslation } from 'react-i18next'
import { Pill, RButton } from '@/components/rialto/primitives'
import type { AccessTokenWire } from '@/lib/api'
import { TOKEN_STATE_PILL, type TokenState } from '@/lib/rialto/settings/access-tokens'

export function TokenDetailPhone({
  token,
  state,
  usageBlocked,
  busy,
  onRotate,
  onRevoke
}: {
  token: AccessTokenWire
  state: TokenState
  usageBlocked: boolean
  busy: boolean
  onRotate: () => void
  onRevoke: () => void
}) {
  const { t } = useTranslation()
  const pill = TOKEN_STATE_PILL[state]
  return (
    <>
      {/* The page header already names the token and leads back to the
          list, so this row carries only what the header cannot: the
          prefix, the state and the two actions. The pills sit under the
          prefix rather than beside it, which is what leaves room for both
          buttons to keep their labels. */}
      <div className='flex items-center gap-3 px-4 pt-4 pb-3'>
        <div className='min-w-0'>
          <div className='truncate font-mono text-[12px] text-muted-foreground'>{token.prefix}</div>
          <div className='mt-1 flex flex-wrap gap-1.5'>
            <Pill tone={pill.tone}>{t(pill.labelKey)}</Pill>
            {state === 'active' && usageBlocked ? <Pill tone='bad'>{t('access.token.usageBlocked')}</Pill> : null}
          </div>
        </div>
        <div className='ml-auto flex shrink-0 items-center gap-2'>
          {/* Absent on an expired token for the desktop header's reason:
              the server refuses to rotate one. */}
          {state === 'active' ? (
            <RButton variant='outline' icon='ri-refresh-line' onClick={onRotate} disabled={busy}>
              {t('settings.access.rotate')}
            </RButton>
          ) : null}
          <RButton variant='danger' icon='ri-forbid-line' onClick={onRevoke} disabled={busy}>
            {t('settings.access.revoke')}
          </RButton>
        </div>
      </div>
    </>
  )
}
