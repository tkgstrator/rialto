/**
 * Stop a half-finished edit from vanishing when the operator navigates.
 *
 * Every Settings screen already tracks a `dirty` flag to enable its
 * Discard/Save pair, and nothing acted on it: clicking "Routing" in the
 * sidebar threw the draft away without a word. That is worst on
 * Personas, whose own copy tells the operator to go and check Routing
 * mid-edit, and on the Access team-domain field, which is only worth
 * typing once the dry run has passed.
 *
 * Two exits need covering and they are not the same mechanism. In-app
 * navigation goes through the data router, so `useBlocker` can stop it
 * and ask — through the app's own AlertDialog, like every other action
 * that throws work away. Closing the tab or reloading never reaches React,
 * so it needs `beforeunload` — which browsers deliberately render as their
 * own generic prompt, ignoring any message passed here.
 */
import { type ReactNode, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useBlocker } from 'react-router-dom'
import { useConfirm } from '@/components/rialto/ConfirmDialog'
import { splitConfirmMessage } from '@/lib/rialto/confirm-message'

/**
 * Returns the confirmation dialog, which the caller must render. A blocked
 * navigation waits on its answer, so a dialog nobody mounted would leave
 * the operator on the page with no way to say either yes or no.
 */
export function useUnsavedGuard(dirty: boolean): ReactNode {
  const { t } = useTranslation()
  const { confirm, dialog } = useConfirm()
  const blocker = useBlocker(dirty)

  // The answer arrives renders later, after the dialog's own updates, so
  // it acts on the blocker as it is then rather than the one the effect
  // closed over. And it asks once per block: a second confirm would settle
  // the first as a refusal and reset the very navigation it was asking about.
  const latest = useRef(blocker)
  latest.current = blocker
  const asking = useRef(false)

  useEffect(() => {
    if (blocker.state !== 'blocked' || asking.current) return
    asking.current = true
    const { title, description } = splitConfirmMessage(t('settings.common.unsavedConfirm'))
    void confirm({ title, description, confirmLabel: t('common.discard') }).then((leave) => {
      asking.current = false
      const current = latest.current
      if (current.state !== 'blocked') return
      if (leave) current.proceed()
      else current.reset()
    })
  }, [blocker.state, confirm, t])

  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Required by older browsers to trigger the prompt at all; the
      // string itself is never displayed.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  return dialog
}
