/**
 * The one-time reveal.
 *
 * `plaintext` exists in exactly one HTTP response for the life of the
 * token — the server stores only its sha256, so there is no endpoint
 * that can produce it again and no retry that recovers it. Everything
 * here follows from that: it is a modal rather than a toast, the copy
 * action is the primary control, and every way out of it — Done, the
 * close button, Escape, a click on the overlay — goes through the same
 * confirm, because a secret that cannot be reissued should not be
 * dismissible by a stray click that a panel would have tolerated.
 *
 * It is the second step of the issue dialog rather than a second dialog:
 * the panel swaps its contents the moment the token exists, so the
 * reveal appears exactly where the operator is already looking.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Pill, RButton } from '@/components/rialto/primitives'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function IssuedTokenDialog({
  plaintext,
  name,
  scope,
  profile,
  expiry,
  titleKey = 'settings.access.issuedTitle',
  bodyKey = 'settings.access.issuedBody',
  onDone
}: {
  plaintext: string
  name: string
  scope: string
  profile: string
  expiry: string
  /**
   * Rotation reveals a secret under exactly these rules, so it reuses
   * this dialog and only renames what happened — a token that was
   * replaced is not one that was just issued, and the copy has to say
   * which, or the operator cannot tell whether the old value still
   * works.
   */
  titleKey?: string
  bodyKey?: string
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
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) dismiss()
      }}
    >
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <div className='flex items-center gap-2'>
            <DialogTitle className='text-sm'>{t(titleKey)}</DialogTitle>
            <Pill tone='warn'>{t('settings.access.issuedCopyNow')}</Pill>
          </div>
        </DialogHeader>

        {/* `min-w-0`, or the token overflows the panel: a 71-character
            unbreakable string is this block's min-content width, and a
            grid item does not shrink below that by default.
            `break-all` rather than `truncate` because the fallback when
            the clipboard write is refused is "select it and copy it
            manually", which needs the whole secret on screen — two
            wrapped lines say more than one elided one. */}
        <div className='min-w-0 space-y-3'>
          <p className='text-[12px] leading-relaxed text-muted-foreground'>{t(bodyKey)}</p>
          <div className='flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2'>
            <span className='min-w-0 flex-1 break-all font-mono text-xs leading-relaxed'>{plaintext}</span>
            <button
              type='button'
              aria-label={t('settings.access.issuedCopyLabel')}
              onClick={copy}
              className='shrink-0 text-muted-foreground transition-colors hover:text-foreground'
            >
              <i className={copied ? 'ri-check-line text-sm text-emerald-500' : 'ri-file-copy-line text-sm'} />
            </button>
          </div>
          <div className='space-y-2'>
            {[
              ['settings.access.issuedName', name],
              ['settings.access.issuedEndpoint', scope],
              ['settings.access.issuedProfile', profile],
              ['settings.access.issuedExpires', expiry]
            ].map(([label, value]) => (
              <div key={label} className='flex items-baseline gap-3'>
                <span className='text-[12px] text-muted-foreground'>{t(label)}</span>
                <span className='ml-auto font-mono text-[12px] tabular-nums'>{value}</span>
              </div>
            ))}
          </div>
        </div>

        <div className='flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end'>
          {copied ? null : (
            <span className='mr-auto text-[12px] text-amber-600 dark:text-amber-400'>
              {t('settings.access.issuedNotCopied')}
            </span>
          )}
          <RButton variant='primary' icon='ri-check-line' onClick={dismiss}>
            {t('common.done')}
          </RButton>
        </div>
      </DialogContent>
    </Dialog>
  )
}
