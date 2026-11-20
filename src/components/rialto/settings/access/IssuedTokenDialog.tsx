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
 * That confirm is an AlertDialog stacked on top of this one. Radix layers
 * nest, so while it is open Escape and focus belong to it alone: backing
 * out of the confirm returns to the token, it does not close the reveal.
 *
 * It is the second step of the issue dialog rather than a second dialog:
 * the panel swaps its contents the moment the token exists, so the
 * reveal appears exactly where the operator is already looking.
 */
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useConfirm } from '@/components/rialto/ConfirmDialog'
import { Pill, RButton } from '@/components/rialto/primitives'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { splitConfirmMessage } from '@/lib/rialto/confirm-message'

export function IssuedTokenDialog({
  plaintext,
  name,
  scope,
  expiry,
  titleKey = 'settings.access.issuedTitle',
  bodyKey = 'settings.access.issuedBody',
  onDone
}: {
  plaintext: string
  name: string
  scope: string
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
  const secretRef = useRef<HTMLSpanElement>(null)
  const copiedRef = useRef(false)
  const copyPending = useRef(false)
  const { confirm, dialog: confirmDialog } = useConfirm()

  const markCopied = () => {
    copiedRef.current = true
    setCopied(true)
  }

  const copySelection = () => {
    const selection = window.getSelection()
    const secret = secretRef.current
    if (secret === null || selection === null) return false
    const before = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    const range = document.createRange()
    range.selectNodeContents(secret)
    selection.removeAllRanges()
    selection.addRange(range)
    try {
      // Clipboard API access is unavailable on the HTTP Tailscale origin.
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      selection.removeAllRanges()
      for (const original of before) selection.addRange(original)
    }
  }

  const copy = async () => {
    if (copyPending.current) return
    copyPending.current = true
    try {
      let succeeded = false
      if (navigator.clipboard?.writeText) {
        succeeded = await navigator.clipboard.writeText(plaintext).then(
          () => true,
          () => false
        )
      }
      if (succeeded || copySelection()) {
        markCopied()
        toast.success(t('settings.access.issuedCopied'))
      } else {
        toast.error(t('settings.access.issuedCopyRefused'))
      }
    } finally {
      copyPending.current = false
    }
  }

  const dismiss = () => {
    if (copyPending.current) return
    if (copiedRef.current) {
      onDone()
      return
    }
    const { title, description } = splitConfirmMessage(t('settings.access.issuedDismissConfirm'))
    void confirm({ title, description, confirmLabel: t('common.discard') }).then((discard) => {
      if (discard) onDone()
    })
  }

  return (
    <>
      <Dialog
        open
        onOpenChange={(next) => {
          if (!next) dismiss()
        }}
      >
        <DialogContent
          className='sm:max-w-md'
          onCopy={(event) => {
            if (!event.defaultPrevented && window.getSelection()?.toString().trim() === plaintext) markCopied()
          }}
        >
          <DialogHeader>
            <div className='flex items-center gap-2'>
              <DialogTitle className='text-sm'>{t(titleKey)}</DialogTitle>
              {copied ? null : <Pill tone='warn'>{t('settings.access.issuedCopyNow')}</Pill>}
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
              <span ref={secretRef} className='min-w-0 flex-1 break-all font-mono text-xs leading-relaxed'>
                {plaintext}
              </span>
              <Button
                variant='outline'
                size='icon-sm'
                type='button'
                aria-label={t('settings.access.issuedCopyLabel')}
                onClick={copy}
                className='shrink-0 text-muted-foreground transition-colors hover:text-foreground'
              >
                <i
                  aria-hidden
                  className={copied ? 'ri-check-line text-sm text-emerald-500' : 'ri-file-copy-line text-sm'}
                />
              </Button>
            </div>
            <div className='space-y-2'>
              {[
                ['settings.access.issuedName', name],
                ['settings.access.issuedEndpoint', scope],
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
      {confirmDialog}
    </>
  )
}
