/**
 * Danger zone.
 *
 * The mock offers three resets — routing, model catalog, captured data.
 * None of them has an endpoint. The one destructive operation the server
 * does expose is the session archive, so that is what this renders; the
 * other three are named as the backend gap they are rather than wired to
 * buttons that would fail on click.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { SectionHead } from '@/components/rialto/settings/fields'
import { NotYetAvailable } from '@/components/rialto/settings/notice'
import { api } from '@/lib/api'

function DangerRow({
  label,
  hint,
  verb,
  onClick,
  disabled
}: {
  label: string
  hint: string
  verb: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <div className='grid grid-cols-[1fr_auto] items-center gap-6 border-t border-border/60 px-6 py-4'>
      <div>
        <div className='text-xs font-medium'>{label}</div>
        <div className='mt-0.5 text-[12px] leading-snug text-muted-foreground'>{hint}</div>
      </div>
      <button
        type='button'
        onClick={onClick}
        disabled={disabled}
        className='inline-flex h-8 items-center rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50'
      >
        {verb}
      </button>
    </div>
  )
}

export function DangerZone() {
  const { t } = useTranslation()
  const [archiving, setArchiving] = useState(false)

  const archive = () => {
    if (!window.confirm(t('settings.advanced.archiveConfirm'))) {
      return
    }
    setArchiving(true)
    api
      .archiveAllSessions()
      .then((res) => toast.success(t('settings.advanced.archived', { n: res.archived })))
      .catch((e: Error) => toast.error(t('settings.advanced.archiveFailed', { message: e.message })))
      .finally(() => setArchiving(false))
  }

  return (
    <>
      <SectionHead title={t('settings.advanced.dangerZone')} />
      <DangerRow
        label={t('settings.advanced.archiveAll')}
        hint={t('settings.advanced.archiveAllHint')}
        verb={t('settings.advanced.archiveVerb')}
        onClick={archive}
        disabled={archiving}
      />
      <div className='px-6 py-4'>
        <NotYetAvailable what={t('settings.advanced.resetWhat')} needs={t('settings.advanced.resetNeeds')} />
      </div>
    </>
  )
}
