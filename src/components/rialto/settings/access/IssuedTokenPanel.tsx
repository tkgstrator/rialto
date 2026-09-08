/**
 * The one-time reveal.
 *
 * `plaintext` exists in exactly one HTTP response for the life of the
 * token — the server stores only its sha256, so there is no endpoint
 * that can produce it again and no retry that recovers it. Everything
 * here follows from that: it is a blocking panel rather than a toast,
 * the copy action is the primary control, and dismissing it says what
 * dismissing costs.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Pill, RButton } from '@/components/rialto/primitives'

export function IssuedTokenPanel({
  plaintext,
  name,
  scope,
  profile,
  expiry,
  onDone
}: {
  plaintext: string
  name: string
  scope: string
  profile: string
  expiry: string
  onDone: () => void
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const copy = () => {
    navigator.clipboard
      .writeText(plaintext)
      .then(() => {
        setCopied(true)
        toast.success(t('settings.access.issuedCopied'))
      })
      .catch(() => toast.error(t('settings.access.issuedCopyRefused')))
  }

  const dismiss = () => {
    // Only guard the case where losing it actually costs something.
    if (copied || window.confirm(t('settings.access.issuedDismissConfirm'))) {
      onDone()
    }
  }

  return (
    <div className='px-6 py-8'>
      <div className='mx-auto max-w-lg rounded-lg border border-border bg-popover p-5 shadow-sm'>
        <div className='flex items-center gap-2'>
          <h3 className='text-sm font-semibold'>{t('settings.access.issuedTitle')}</h3>
          <Pill tone='warn'>{t('settings.access.issuedCopyNow')}</Pill>
        </div>
        <p className='mt-1.5 text-[12px] leading-relaxed text-muted-foreground'>{t('settings.access.issuedBody')}</p>
        <div className='mt-3 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2'>
          <span className='flex-1 truncate font-mono text-xs'>{plaintext}</span>
          <button
            type='button'
            aria-label={t('settings.access.issuedCopyLabel')}
            onClick={copy}
            className='text-muted-foreground transition-colors hover:text-foreground'
          >
            <i className={copied ? 'ri-check-line text-sm text-emerald-500' : 'ri-file-copy-line text-sm'} />
          </button>
        </div>
        <div className='mt-4 space-y-2'>
          {[
            ['settings.access.issuedName', name],
            ['settings.access.issuedEndpoint', scope],
            ['settings.access.issuedProfile', profile],
            ['settings.access.issuedExpires', expiry]
          ].map(([label, value]) => (
            <div key={label} className='flex items-baseline gap-3'>
              <span className='text-[12px] text-muted-foreground'>{t(label)}</span>
              <span className='ml-auto font-mono text-[12px]'>{value}</span>
            </div>
          ))}
        </div>
        <div className='mt-4 flex items-center justify-end gap-2'>
          {copied ? null : (
            <span className='mr-auto text-[12px] text-amber-600 dark:text-amber-400'>
              {t('settings.access.issuedNotCopied')}
            </span>
          )}
          <RButton variant='primary' icon='ri-check-line' onClick={dismiss}>
            {t('common.done')}
          </RButton>
        </div>
      </div>
    </div>
  )
}
