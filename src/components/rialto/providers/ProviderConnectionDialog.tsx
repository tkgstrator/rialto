import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { RButton } from '@/components/rialto/primitives'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import type { Provider } from '@/schemas/domain/provider'
import { isProviderBaseUrl } from '@/shared/provider-base-url'

export function ProviderConnectionDialog({
  provider,
  label,
  onClose,
  onSaved
}: {
  provider: Provider
  label: string
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const nameId = useId()
  const urlId = useId()
  const urlHint = useId()
  const [name, setName] = useState(provider.display_name == null ? '' : provider.display_name)
  const [baseUrl, setBaseUrl] = useState(provider.api_base_url)
  const [saving, setSaving] = useState(false)
  const displayName = name.trim() === '' ? null : name.trim()
  const urlChanged = provider.auth_mode === 'api_key' && baseUrl.trim() !== provider.api_base_url
  const invalidUrl = urlChanged && !isProviderBaseUrl(baseUrl.trim())
  const dirty = displayName !== (provider.display_name === undefined ? null : provider.display_name) || urlChanged

  const save = async () => {
    if (!dirty || invalidUrl || saving) return
    setSaving(true)
    try {
      await api.updateProviderConnection(provider.name, {
        display_name: displayName,
        ...(urlChanged ? { api_base_url: baseUrl.trim() } : {})
      })
      toast.success(t('providers.detail.saved', { name: displayName === null ? label : displayName }))
      onSaved()
    } catch (error) {
      toast.error(t('settings.common.saveFailed', { message: error instanceof Error ? error.message : String(error) }))
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('providers.credentials.editConnection')}</DialogTitle>
        </DialogHeader>
        <div className='grid gap-2'>
          <Label htmlFor={nameId}>{t('providers.credentials.displayName')}</Label>
          <Input
            id={nameId}
            value={name}
            placeholder={label}
            maxLength={120}
            disabled={saving}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        {provider.auth_mode === 'api_key' ? (
          <div className='grid gap-2'>
            <Label htmlFor={urlId}>{t('providers.credentials.baseUrl')}</Label>
            <Input
              id={urlId}
              type='url'
              value={baseUrl}
              disabled={saving}
              aria-invalid={invalidUrl}
              aria-describedby={urlHint}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            <p id={urlHint} className={invalidUrl ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
              {t(invalidUrl ? 'providers.credentials.invalidBaseUrl' : 'providers.credentials.baseUrlEditHint')}
            </p>
          </div>
        ) : null}
        <div className='flex justify-end gap-2'>
          <RButton variant='outline' disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </RButton>
          <RButton variant='primary' disabled={saving || !dirty || invalidUrl} onClick={save}>
            {t('common.save')}
          </RButton>
        </div>
      </DialogContent>
    </Dialog>
  )
}
