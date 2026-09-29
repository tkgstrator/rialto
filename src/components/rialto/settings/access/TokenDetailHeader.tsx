import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Pill, RButton } from '@/components/rialto/primitives'
import type { AccessTokenWire } from '@/lib/api'
import { TOKEN_STATE_PILL, type TokenState } from '@/lib/rialto/settings/access-tokens'

/** Keep destructive controls on the token's detail page, never in the list. */
export function TokenDetailHeader({
  token,
  state,
  usageBlocked,
  busy,
  onRotate,
  onRevoke,
  onDelete
}: {
  token: AccessTokenWire
  state: TokenState
  /** Refused by its plan's usage windows right now, though the credential itself is fine. */
  usageBlocked: boolean
  busy: boolean
  onRotate: () => void
  onRevoke: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const pill = TOKEN_STATE_PILL[state]
  return (
    <div className='flex items-center gap-3 px-6 pt-6 pb-3'>
      <Link
        to='/access-tokens'
        className='text-muted-foreground hover:text-foreground'
        aria-label={t('settings.access.backToTokens')}
      >
        <i className='ri-arrow-left-line text-base' />
      </Link>
      <div className='min-w-0'>
        <div className='truncate text-sm font-semibold'>{token.name}</div>
        <div className='font-mono text-[12px] text-muted-foreground'>{token.prefix}</div>
      </div>
      <Pill tone={pill.tone}>{t(pill.labelKey)}</Pill>
      {state === 'active' && usageBlocked ? <Pill tone='bad'>{t('access.token.usageBlocked')}</Pill> : null}
      <div className='ml-auto flex items-center gap-2'>
        {/* Rotate first and revoke second: rotating is the answer to
            almost every reason for being on this page, and revoking is
            the one that takes a client offline.
            Absent rather than disabled on a dead token: a new secret on
            a revoked or expired row would not authenticate, so the
            server refuses the call outright — there is no state in which
            this control could become live, and a permanently greyed-out
            button is clutter rather than information. */}
        {state === 'active' ? (
          <RButton variant='outline' icon='ri-refresh-line' onClick={onRotate} disabled={busy}>
            {t('settings.access.rotate')}
          </RButton>
        ) : null}
        {state === 'revoked' ? (
          <RButton variant='danger' icon='ri-delete-bin-line' onClick={onDelete} disabled={busy}>
            {t('settings.access.delete')}
          </RButton>
        ) : (
          <RButton variant='danger' icon='ri-forbid-line' onClick={onRevoke} disabled={busy}>
            {t('settings.access.revoke')}
          </RButton>
        )}
      </div>
    </div>
  )
}
