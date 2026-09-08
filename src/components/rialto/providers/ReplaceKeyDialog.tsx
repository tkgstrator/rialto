/**
 * Deliberate replacement of an api_key provider's outbound credential.
 *
 * The panel behind this is read-only on purpose: the key field used to
 * become an editable input as soon as it was revealed, which put a
 * working credential one stray keystroke away from being overwritten by
 * whatever was typed next. Changing a key is rare and consequential, so
 * it gets its own dialog and its own confirm rather than sharing a
 * surface with "let me look at what is configured".
 *
 * The current value is shown masked for orientation only — this dialog
 * never reveals it. Reveal lives on the panel, where looking at a key and
 * changing one stay separate actions.
 */
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { RButton } from '@/components/rialto/primitives'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { maskKey } from './derive'

export function ReplaceKeyDialog({
  open,
  current,
  onOpenChange,
  onReplace
}: {
  open: boolean
  /** The stored key, masked here. Empty when the provider has none yet. */
  current: string
  onOpenChange: (open: boolean) => void
  onReplace: (key: string) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')

  const close = () => {
    setDraft('')
    onOpenChange(false)
  }

  const submit = () => {
    const next = draft.trim()
    if (next.length === 0) return
    onReplace(next)
    close()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle className='text-sm'>{t('providers.credentials.replaceTitle')}</DialogTitle>
        </DialogHeader>
        <div className='space-y-3'>
          <div>
            <div className='mb-1 text-[12px] text-muted-foreground'>{t('providers.credentials.replaceCurrent')}</div>
            <div className='flex h-8 min-w-0 items-center rounded-md border border-border px-3 font-mono text-xs text-muted-foreground'>
              <span className='truncate'>{current === '' ? t('providers.credentials.notSet') : maskKey(current)}</span>
            </div>
          </div>
          <div>
            <div className='mb-1 text-[12px] text-muted-foreground'>{t('providers.credentials.replaceNew')}</div>
            {/* The dialog exists to take this one value, so the caret
                belongs here on open rather than on Radix's close button. */}
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
              placeholder={t('providers.credentials.replacePlaceholder')}
              spellCheck={false}
              autoComplete='off'
              className='h-8 w-full min-w-0 rounded-md border border-border bg-transparent px-3 font-mono text-xs outline-none focus:border-foreground/40'
            />
          </div>
          <p className='text-[12px] leading-relaxed text-muted-foreground'>
            <Trans i18nKey='providers.credentials.replaceNote' components={{ mono: <span className='font-mono' /> }} />
          </p>
        </div>
        <div className='flex items-center justify-end gap-2'>
          <RButton variant='ghost' onClick={close}>
            {t('common.cancel')}
          </RButton>
          <RButton variant='primary' icon='ri-refresh-line' onClick={submit} disabled={draft.trim().length === 0}>
            {t('providers.credentials.replaceSubmit')}
          </RButton>
        </div>
      </DialogContent>
    </Dialog>
  )
}
