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
 * and ask. Closing the tab or reloading never reaches React, so it needs
 * `beforeunload` — which browsers deliberately render as their own
 * generic prompt, ignoring any message passed here.
 */
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useBlocker } from 'react-router-dom'

export function useUnsavedGuard(dirty: boolean): void {
  const { t } = useTranslation()

  const blocker = useBlocker(dirty)

  useEffect(() => {
    if (blocker.state !== 'blocked') return
    // Asking inside the effect rather than in a blocker function keeps the
    // confirm out of render, where React may call it twice under Strict
    // Mode and show the operator two dialogs for one click.
    if (window.confirm(t('settings.common.unsavedConfirm'))) blocker.proceed()
    else blocker.reset()
  }, [blocker, t])

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
}
