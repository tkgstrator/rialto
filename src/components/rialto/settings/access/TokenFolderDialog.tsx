import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { RButton } from '@/components/rialto/primitives'
import { SelectPicker } from '@/components/rialto/SelectPicker'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api, type PlanWire } from '@/lib/api'
import type { TokenFolder } from '@/shared/access-token-policy'
import { FolderPicker, ProviderModeFields } from './TokenPolicyFields'

export function TokenFolderDialog({
  folder,
  parentId,
  folders,
  plans,
  onSaved,
  onClose
}: {
  folder: TokenFolder | null
  parentId: string | null
  folders: readonly TokenFolder[]
  plans: readonly PlanWire[]
  onSaved: (folder: TokenFolder) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<Omit<TokenFolder, 'id'>>(
    folder === null
      ? {
          name: '',
          parentId,
          defaultPlanId: null,
          defaultProviderMode: 'system',
          defaultProviderFallback: false
        }
      : folder
  )
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      onSaved(await api.saveTokenFolder(folder === null ? null : folder.id, draft))
    } catch (error) {
      toast.error(t('settings.common.saveFailed', { message: error instanceof Error ? error.message : String(error) }))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>{t(folder === null ? 'settings.access.folderNew' : 'settings.access.folderEdit')}</DialogTitle>
        </DialogHeader>
        <fieldset disabled={busy} className='grid gap-3 text-xs'>
          <label className='grid gap-1'>
            {t('settings.access.folderName')}
            <input
              autoFocus
              maxLength={100}
              value={draft.name}
              className='h-8 rounded-md border border-border px-2'
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <div className='grid gap-1'>
            {t('settings.access.folderParent')}
            <FolderPicker
              folders={folders.filter((entry) => entry.id !== folder?.id)}
              value={draft.parentId}
              onChange={(next) => setDraft({ ...draft, parentId: next })}
              disabled={busy}
              label={t('settings.access.folderParent')}
            />
          </div>
          <div className='grid gap-1'>
            {t('settings.access.folderDefaultPlan')}
            <SelectPicker
              label={t('settings.access.folderDefaultPlan')}
              className='w-full'
              value={draft.defaultPlanId === null ? '' : draft.defaultPlanId}
              disabled={busy}
              onChange={(next) => setDraft({ ...draft, defaultPlanId: next === '' ? null : next })}
              options={[
                { value: '', label: t('settings.access.folderNoDefaultPlan') },
                ...plans.map((plan) => ({ value: plan.id, label: plan.name }))
              ]}
            />
          </div>
          <ProviderModeFields
            disabled={busy}
            value={{ providerMode: draft.defaultProviderMode, providerFallback: draft.defaultProviderFallback }}
            onChange={(next) =>
              setDraft({
                ...draft,
                defaultProviderMode: next.providerMode,
                defaultProviderFallback: next.providerFallback
              })
            }
          />
        </fieldset>
        <div className='flex justify-end gap-2'>
          <RButton variant='outline' onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </RButton>
          <RButton variant='primary' onClick={save} disabled={busy || !draft.name.trim()}>
            {t('common.save')}
          </RButton>
        </div>
      </DialogContent>
    </Dialog>
  )
}
