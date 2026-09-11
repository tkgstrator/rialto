/**
 * The confirmation every irreversible action goes through.
 *
 * `window.confirm` fell short twice over: it cannot say how bad the action
 * is — the button that destroys looks like any OK — and it renders outside
 * the app, in the browser's own chrome and language. This is an AlertDialog
 * instead: the title names the action, the description says what is lost,
 * and the button that does it is the same red one that opened it.
 *
 * `useConfirm` keeps call sites the shape they had: `if (!(await
 * confirm({...}))) return` where `window.confirm` stood, plus rendering the
 * `dialog` the hook hands back.
 */
import { AlertDialog } from 'radix-ui'
import { type ReactNode, useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RButton } from '@/components/rialto/primitives'
import {
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'

export interface ConfirmRequest {
  /** Names the action, as a question: "Remove OpenAI?". */
  title: string
  /** What goes with it, stated before the click. Blank lines separate paragraphs. */
  description: string
  /** The button that does it — the same words as the one that opened the dialog. */
  confirmLabel: string
  /** Remix icon class for that button, when the opener had one. */
  icon?: string
}

function ConfirmDialog({
  request,
  onConfirm,
  onCancel,
  onCloseAutoFocus
}: {
  request: ConfirmRequest | null
  onConfirm: () => void
  onCancel: () => void
  onCloseAutoFocus: (event: Event) => void
}) {
  const { t } = useTranslation()
  // Root, Cancel and Action come straight from Radix: the ui kit's Cancel
  // and Action wrap its own Button, and the buttons in here have to be the
  // house RButton — the red one must be the same red as the one that opened
  // it. Content, header and footer are the ui kit's, so the dialog itself
  // looks like every other dialog in the app.
  return (
    <AlertDialog.Root
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      {request === null ? null : (
        // AlertDialogContent's own presets are max-w-xs (size="sm") or
        // sm:max-w-lg (size="default", the one in play here) — neither is
        // the app's usual dialog width. Overriding plain `sm:max-w-md`
        // loses to `data-[size=default]:sm:max-w-lg` on specificity, since
        // an attribute-guarded selector always beats an unguarded one
        // regardless of source order, so the override has to carry the
        // same `data-[size=default]:` guard for `cn` to treat it as the
        // same conflicting utility and drop the wider one.
        <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus} className='data-[size=default]:sm:max-w-md'>
          <AlertDialogHeader>
            <AlertDialogTitle className='text-sm'>{request.title}</AlertDialogTitle>
            {/* pre-line: a warning appended after a blank line is a second
                paragraph, and collapsing it into the first hid it. */}
            <AlertDialogDescription className='whitespace-pre-line text-xs leading-relaxed'>
              {request.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/* Radix's Cancel takes the focus when the dialog opens, so an
                Enter pressed out of habit backs out instead of destroying. */}
            <AlertDialog.Cancel asChild>
              <RButton variant='ghost'>{t('common.cancel')}</RButton>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <RButton variant='danger' icon={request.icon} onClick={onConfirm}>
                {request.confirmLabel}
              </RButton>
            </AlertDialog.Action>
          </AlertDialogFooter>
          {/* Same corner close affordance every other dialog in the app
              carries. It backs out exactly like Cancel — Radix's Cancel
              part, not a bare button, so Escape/outside-click and this
              button settle the same promise through the one onOpenChange
              path above. */}
          <AlertDialog.Cancel asChild>
            <button
              type='button'
              aria-label={t('common.cancel')}
              className='absolute top-4 right-4 inline-flex size-8 shrink-0 items-center justify-center rounded-[min(var(--radius-md),10px)] border border-transparent text-sm transition-all hover:bg-muted hover:text-foreground'
            >
              <i className='ri-close-line text-base leading-none' />
            </button>
          </AlertDialog.Cancel>
        </AlertDialogContent>
      )}
    </AlertDialog.Root>
  )
}

interface PendingConfirm {
  request: ConfirmRequest
  resolve: (confirmed: boolean) => void
}

/**
 * Ask before an irreversible action. Resolves true only when the red
 * button was pressed; Cancel, Escape and a click outside all resolve false.
 */
export function useConfirm(): { confirm: (request: ConfirmRequest) => Promise<boolean>; dialog: ReactNode } {
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  // Where the focus was when the dialog opened. The dialog is opened by a
  // call, not by a Radix Trigger, so Radix has nowhere to return focus to
  // on close and leaves it on <body> — a keyboard user who backs out lands
  // at the top of the page instead of on the button they pressed.
  const returnFocus = useRef<HTMLElement | null>(null)

  const confirm = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        const active = document.activeElement
        returnFocus.current = active instanceof HTMLElement ? active : null
        setPending((previous) => {
          // A second request replaces the first, which must not be left
          // awaiting forever: it counts as backed out.
          if (previous !== null) previous.resolve(false)
          return { request, resolve }
        })
      }),
    []
  )

  // The red button's handler runs before the dialog's own close fires the
  // cancel path, and a promise keeps its first answer, so that second
  // settle changes nothing.
  const settle = (confirmed: boolean) => {
    if (pending === null) return
    pending.resolve(confirmed)
    setPending(null)
  }

  const restoreFocus = (event: Event) => {
    event.preventDefault()
    returnFocus.current?.focus()
    returnFocus.current = null
  }

  const dialog = (
    <ConfirmDialog
      request={pending === null ? null : pending.request}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
      onCloseAutoFocus={restoreFocus}
    />
  )
  return { confirm, dialog }
}
