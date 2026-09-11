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
import { useConfirm } from '@/components/rialto/ConfirmDialog'
import { RButton } from '@/components/rialto/primitives'
import { SectionHead } from '@/components/rialto/settings/fields'
import { NotYetAvailable } from '@/components/rialto/settings/notice'
import { api } from '@/lib/api'
import { splitConfirmMessage } from '@/lib/rialto/confirm-message'

function DangerRow({
  label,
  hint,
  verb,
  icon,
  onClick,
  disabled
}: {
  label: string
  hint: string
  verb: string
  icon: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <div className='grid grid-cols-[1fr_auto] items-center gap-6 border-t border-border/60 px-6 py-4'>
      <div>
        <div className='text-xs font-medium'>{label}</div>
        <div className='mt-0.5 text-[12px] leading-snug text-muted-foreground'>{hint}</div>
      </div>
      {/* The house red button rather than a hand-drawn one, so it is the
          same red as the confirm it opens and every other irreversible
          action in the app. */}
      <RButton variant='danger' icon={icon} onClick={onClick} disabled={disabled}>
        {verb}
      </RButton>
    </div>
  )
}

export function DangerZone() {
  const { t } = useTranslation()
  const [archiving, setArchiving] = useState(false)
  const { confirm, dialog: confirmDialog } = useConfirm()

  const archive = async () => {
    const { title, description } = splitConfirmMessage(t('settings.advanced.archiveConfirm'))
    const confirmed = await confirm({
      title,
      description,
      confirmLabel: t('settings.advanced.archiveVerb'),
      icon: 'ri-archive-line'
    })
    if (!confirmed) return
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
        icon='ri-archive-line'
        onClick={archive}
        disabled={archiving}
      />
      <div className='px-6 py-4'>
        <NotYetAvailable what={t('settings.advanced.resetWhat')} needs={t('settings.advanced.resetNeeds')} />
      </div>
      {confirmDialog}
    </>
  )
}
